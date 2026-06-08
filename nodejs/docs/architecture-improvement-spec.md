# 架构改进规格文档

> 基于代码评审的系统性改进方案，按优先级分为 P0/P1/P2/P3 四个等级。

---

## 目录

- [1. 核心缺陷修复（P0）](#1-核心缺陷修复p0)
  - [1.1 并行执行改造](#11-并行执行改造)
  - [1.2 预算约束真实化](#12-预算约束真实化)
  - [1.3 双入口统一](#13-双入口统一)
- [2. 设计优化（P1）](#2-设计优化p1)
  - [2.1 RAG 端到端评估](#21-rag-端到端评估)
  - [2.2 DestinationAgent 重构](#22-destinationagent-重构)
  - [2.3 XHS 稳定性文档化](#23-xhs-稳定性文档化)
- [3. 工程细节修正（P2）](#3-工程细节修正p2)
  - [3.1 分层 Temperature 配置](#31-分层-temperature-配置)
  - [3.2 LLMPlanAgent 独立 maxTokens](#32-llmplanagent-独立-maxtokens)
  - [3.3 轻量模型路由落地](#33-轻量模型路由落地)
  - [3.4 VectorStore 预热与升级阈值](#34-vectorstore-预热与升级阈值)
- [4. 行业对标提升（P3）](#4-行业对标提升p3)
  - [4.1 Checkpoint 持久化](#41-checkpoint-持久化)
  - [4.2 Human-in-the-loop 抽象](#42-human-in-the-loop-抽象)
  - [4.3 端到端 Eval Pipeline](#43-端到端-eval-pipeline)
- [5. 附录：改动文件清单](#5-附录改动文件清单)

---

## 1. 核心缺陷修复（P0）

### 1.1 并行执行改造

**现状**（`src/orchestrator/parallel.ts:35-46`）：

`ParallelExecutor` 的注释明确写了"实际为顺序执行"，其 `run()` 方法使用 `for...of` 逐个串行执行 Agent：

```typescript
for (const agent of this.agents) {
  const result = await this.runSingle(agent, state);
  results.push(result);
}
```

Pipeline 调用路径（`src/orchestrator/pipeline.ts:70`）：

```
ParallelExecutor([flightAgent, hotelAgent, llmPlanAgent])
```

BudgetLoop 最多 3 轮。极端情况下：3 × (120s + 120s + 120s) = 1080s = 18 分钟。

关键事实：**FlightAgent 和 HotelAgent 之间没有数据依赖**，它们各自独立搜索，只写入 state 的不同字段（`state.flightResult` vs `state.hotelResult`）。只有 LLMPlanAgent 依赖前两者的结果。

**目标**：

- FlightAgent 和 HotelAgent 通过 `Promise.allSettled` 真正并行执行
- LLMPlanAgent 等待前两者完成后才启动
- 延迟预期降低 40-50%（从 3×T 降到 2×T）

**改动文件**：

| 文件 | 改动 |
|------|------|
| `src/orchestrator/parallel.ts` | 重命名 `ParallelExecutor` → `PipelineExecutor`；新增 `runParallel(agents[], state)` 方法使用 `Promise.allSettled`；保留 `runSequential` 用于有依赖关系的 Agent |
| `src/orchestrator/pipeline.ts:70` | 修改构造：先 `runParallel([flightAgent, hotelAgent])`，再 `runSequential([llmPlanAgent])` |
| `src/orchestrator/budget-loop.ts:28` | 适配新的 executor 接口 |

**验收标准**：

- [ ] FlightAgent 和 HotelAgent 的搜索日志时间戳重叠（证明并行）
- [ ] Pipeline 端到端延迟在同等条件下降低 ≥ 35%
- [ ] 任意一个 Agent 失败不影响另一个（`allSettled` 行为）
- [ ] 现有测试通过

---

### 1.2 预算约束真实化

**现状**（`src/agents/budget-agent.ts:67-102`）：

`BudgetAgent.computeConstraints()` 生成越来越紧的 `SearchConstraints`（如 `maxFlightPricePerPerson`、`maxHotelPricePerNight`），写入 `state.searchConstraints`。但检查各 Agent：

- `FlightAgent`：**不读取** `state.searchConstraints`
- `HotelAgent`：**不读取** `state.searchConstraints`
- `LLMPlanAgent`：**不读取** `state.searchConstraints`

这意味着 BudgetLoop 的"削减"是假动作——系统反复搜索同一个价格范围的航班和酒店，然后 BudgetAgent 只在纸面上降低预算数字，并未真正传导到数据源层。

**目标**：

- `searchConstraints` 作为参数传入各 Agent 的搜索方法
- 数据源层（AmadeusSource、BookingSource）接收 `maxPrice` 参数过滤结果
- BudgetLoop 的每一轮都基于更紧的预算**重新搜索**，而非对已有结果做数学游戏

**改动文件**：

| 文件 | 改动 |
|------|------|
| `src/types/index.ts` | 确认 `SearchConstraints` 类型已包含完整的价格/星级约束字段 |
| `src/agents/flight-agent.ts` | `execute()` 中读取 `state.searchConstraints?.maxFlightPricePerPerson`，传入 `searchFlights()` 的 `maxPrice` 参数 |
| `src/agents/hotel-agent.ts` | `execute()` 中读取 `state.searchConstraints?.maxHotelPricePerNight` 和 `maxHotelStarRating`，传入 `searchHotels()` |
| `src/agents/llm-plan-agent.ts` | `execute()` 中读取 `state.searchConstraints?.maxActivityCostPerDay`，约束活动推荐 |
| `src/data-sources/types.ts` | 确认 `searchFlights`、`searchHotels` 参数已包含 `maxPrice` 等过滤字段 |
| `src/data-sources/amadeus-source.ts` | 实现 `maxPrice` 参数过滤 |
| `src/data-sources/booking-source.ts` | 实现 `maxPrice` / `maxStarRating` 参数过滤 |
| `src/orchestrator/budget-loop.ts` | 确保每轮调整前 `state.searchConstraints` 已更新并传递 |

**验收标准**：

- [ ] 超预算场景下，第 2 轮搜索返回的航班价格 ≤ `maxFlightPricePerPerson`
- [ ] 超预算场景下，第 2 轮搜索返回的酒店价格 ≤ `maxHotelPricePerNight`
- [ ] 日志可追踪每轮搜索的价格约束变化
- [ ] 最终输出的价格均为真实可预订价格

---

### 1.3 双入口统一

**现状**：

系统存在两套并行的请求入口和工具体系：

| 维度 | 旧入口 | 新入口 |
|------|--------|--------|
| 路由 | `POST /api/chat/stream` | `POST /api/chat/:sid` |
| Handler | `src/api/stream-handler.ts:24` `handleChatStream` | `src/api/stream-handler.ts:131` `handleConversationMessage` |
| 编排 | LLM Agent Loop（tools.ts 的 ToolRegistry） | ConversationOrchestrator → TurnHandler → Pipeline |
| 工具定义 | `src/api/tools.ts` 注册 8 个工具 | `src/tools/registry.ts` 注册 8 个工具 + `src/tools/definitions/` |
| SSE 事件 | `text_delta`, `tool_start`, `tool_result`, `reference_sources` | `text_delta`, `state_change`, `needs_input`, `plan_summary` 等 |
| 状态管理 | 无（内存 messages 数组） | ConversationContext + SessionStore（TTL） |

两者各自维护一套状态、一套事件类型、一套工具调用路径，没有统一抽象。任何核心改动需要修两处。

**目标**：统一为新入口，废弃旧入口。

**改动文件**：

| 文件 | 改动 |
|------|------|
| `src/api/routes.ts:22-28` | 删除 `POST /api/chat/stream` 路由；可能返回 410 或重定向到新入口 |
| `src/api/stream-handler.ts` | 删除 `handleChatStream` 和 `runAgentLoop`；保留 `handleConversationMessage` 和 `handleSelectMessage` |
| `src/api/tools.ts` | 删除，或以 `src/tools/registry.ts` 为单一数据源 |
| `src/tools/registry.ts` | 确认所有工具定义完备，补充迁移过程中缺失的工具 |
| `src/public/chat.html` | 前端切换为使用新 API 路径（`/api/chat` + `/api/chat/:sid`） |

**验收标准**：

- [ ] `POST /api/chat/stream` 返回 410 Gone 或重定向，不保留旧逻辑
- [ ] 新入口覆盖旧入口的全部功能（工具调用、SSE 流式、引用来源展示）
- [ ] 工具定义只有 `src/tools/registry.ts` 一个入口注册
- [ ] 前端 chat.html 正常工作，无 console 错误

---

## 2. 设计优化（P1）

### 2.1 RAG 端到端评估

**现状**（`src/rag/eval.ts`）：

RAG 评估系统只测量向量检索质量（Hit Rate 71.8%、MRR、Recall@10、P95 延迟），未测量 RAG 注入后对行程生成质量的实际影响。可能出现的情况：RAG 检索命中了正确文档，但 LLMPlanAgent 在生成行程时完全不使用这些内容。

**目标**：建立两层评估之间的连接——测量 RAG 内容在最终行程中的实际利用率和对准确率的提升。

**改动文件**：

| 文件 | 改动 |
|------|------|
| `src/rag/eval.ts` | 新增 `evalEndToEnd()` 函数：对同一查询对比"有 RAG"和"无 RAG"两种模式下的行程输出 |
| `src/agents/llm-plan-agent.ts` | `execute()` 中标记哪些行程元素来自 RAG 数据源 |
| `src/orchestrator/pipeline.ts` | 支持 `ragEnabled: boolean` 参数用于对比测试 |
| `nodejs/data/eval/` | 新增 `e2e-queries.jsonl` 测试集，每项包含查询、期望景点、期望餐厅 |

**新增评估指标**：

| 指标 | 定义 |
|------|------|
| RAG Utilization Rate | RAG 返回的景点/餐厅中，被最终行程引用的比例 |
| Plan Accuracy Diff | 有 RAG vs 无 RAG 的行程景点准确率差值 |
| Hallucination Rate | 行程中不存在的景点/餐厅占比 |

**验收标准**：

- [ ] `evalEndToEnd()` 可独立运行，输出 Utilization Rate 和 Accuracy Diff
- [ ] baseline.jsonl 增加 e2e 指标记录
- [ ] RAG Utilization Rate > 60%（证明 RAG 确实被使用）

---

### 2.2 DestinationAgent 重构

**现状**（`src/agents/destination-agent.ts`）：

- 用户必须已指定 `preferredDestination`
- Agent 唯一做的事：调用 LLM 生成目的地描述（签证、消费水平、亮点）
- 无工具调用、无决策逻辑、无外部状态写入（只写 `state.destinationRec`）
- 这不是一个 Agent，它是一个 LLM 调用包装

**目标**：降级为普通工具函数，内联到 Pipeline 初始化阶段。

**改动文件**：

| 文件 | 改动 |
|------|------|
| `src/agents/destination-agent.ts` | 删除类，提取为 `enrichDestination(city, budget): Promise<Destination>` 纯函数 |
| `src/orchestrator/pipeline.ts:67-68,82` | 替换 `destAgent.run(state)` 为 `state.destinationRec = await enrichDestination(...)` |
| `src/agents/index.ts` | 移除 `DestinationAgent` 导出 |
| `src/agents/base-agent.ts` | 如无其他子类使用，`callLlm()` 方法可移至公共 utils |

**验收标准**：

- [ ] `enrichDestination()` 是纯函数，无副作用，输入 city+预算，输出 Destination
- [ ] Pipeline 行为不变：目的地信息仍然在搜索阶段前填充
- [ ] 减少一个无意义的 Agent 类

---

### 2.3 XHS 稳定性文档化

**现状**：

`xhs-service/` 是基于 `Spider_XHS` 的逆向爬虫微服务，不是官方 API。小红书更新反爬策略时可能直接失效。当前 pipeline 的工具节点如果调用失败，降级路径未在文档中说明。

**目标**：文档化 XHS 的降级路径、SLA 和监控策略。

**改动文件**：

| 文件 | 改动 |
|------|------|
| `xhs-service/README.md` | 新增"稳定性与降级"章节 |
| `src/tools/definitions/search-xhs.ts` | 确认已有 timeout + fallback 返回空数组 |

**XHS 降级路径**：

```
search_xhs(query)
  ├─ XHS Spider 正常 → 返回笔记摘要列表
  ├─ XHS Spider 超时 (>10s) → 返回 []，日志 WARN
  ├─ XHS Spider 反爬拦截 (403/验证码) → 返回 []，日志 ERROR，触发告警
  └─ XHS 微服务不可达 → 返回 []，日志 ERROR
```

**监控指标**：

| 指标 | 阈值 |
|------|------|
| XHS 请求成功率 | > 80%（低于时告警） |
| XHS P95 延迟 | < 15s |
| XHS 反爬拦截率 | < 10% |

**验收标准**：

- [ ] `xhs-service/README.md` 明确写出降级路径
- [ ] 前端在 XHS 数据缺失时不报错，正常展示其他来源

---

## 3. 工程细节修正（P2）

### 3.1 分层 Temperature 配置

**现状**（`src/config/settings.ts`）：

只有一个全局 `LLM_TEMPERATURE: 0.7`，所有 LLM 调用共用。对于结构化 JSON 输出任务（InfoExtractor 偏好提取、DestinationAgent 目的地信息），0.7 的随机性太高，JSON 解析失败率高于必要水平。

**目标**：按任务类型分层配置 temperature。

**改动文件**：

| 文件 | 改动 |
|------|------|
| `src/config/settings.ts` | 新增 `LLM_TEMPERATURE_STRUCTURED`（默认 0.1）、`LLM_TEMPERATURE_CREATIVE`（默认 0.7）、`LLM_TEMPERATURE_CHAT`（默认 0.6） |
| `src/conversation/info-extractor.ts` | 使用 `LLM_TEMPERATURE_STRUCTURED` |
| `src/agents/destination-agent.ts` | 使用 `LLM_TEMPERATURE_STRUCTURED`（重构后改为函数） |
| `src/agents/llm-plan-agent.ts` | 使用 `LLM_TEMPERATURE_CREATIVE` |
| `src/agents/gathering-agent.ts` | 使用 `LLM_TEMPERATURE_CHAT` |

**推荐的 Temperature 分层**：

| 任务类型 | Temperature | 理由 |
|----------|-------------|------|
| 结构化提取（InfoExtractor, enDestination） | 0.1 | 需要稳定的 JSON 输出 |
| 行程生成（LLMPlanAgent） | 0.7 | 需要多样性 |
| 对话（GatheringAgent, 聊天） | 0.6 | 自然但有约束 |
| 预算判断（BudgetAgent，纯代码逻辑） | N/A | 不使用 LLM |

**验收标准**：

- [ ] `settings.ts` 包含 3 个 temperature 配置项
- [ ] 各 Agent 使用对应的 temperature 值
- [ ] InfoExtractor 的 JSON 解析成功率 ≥ 98%

---

### 3.2 LLMPlanAgent 独立 maxTokens

**现状**（`src/config/settings.ts`）：

全局 `LLM_MAX_TOKENS: 4096`。LLMPlanAgent 生成 7 天详细行程（每天含交通衔接、景点描述、餐厅推荐），4096 tokens 在输出中文文本时约等于 6000-8000 字。7 天行程的描述很容易超过这个量，导致输出被截断。

**目标**：LLMPlanAgent 使用独立的、更高的 maxTokens。

**改动文件**：

| 文件 | 改动 |
|------|------|
| `src/config/settings.ts` | 新增 `LLM_MAX_TOKENS_PLAN`（默认 8192 或 16384） |
| `src/agents/llm-plan-agent.ts` | 调用 LLM 时传入 `LLM_MAX_TOKENS_PLAN` |
| `src/agents/base-agent.ts` | `callLlm()` 方法支持传入 `maxTokens` 覆盖全局默认值 |

**验收标准**：

- [ ] `LLM_MAX_TOKENS_PLAN` 默认值 ≥ 8192
- [ ] 7 天行程输出不发生截断
- [ ] 其他 Agent 继续使用全局 `LLM_MAX_TOKENS`

---

### 3.3 轻量模型路由落地

**现状**（`src/config/settings.ts`）：

配置了 `LLM_LIGHT_MODEL: "glm-4.7"`，但代码中没有一处根据任务类型选择不同模型的逻辑。所有 LLM 调用都使用 `LLM_MODEL`。

**目标**：定义哪些任务使用轻量模型，并在代码中落地路由。

**改动文件**：

| 文件 | 改动 |
|------|------|
| `src/config/settings.ts` | 确认 `LLM_LIGHT_MODEL` 配置正确 |
| `src/agents/base-agent.ts` | `callLlm()` 支持 `model` 参数覆盖 |
| `src/conversation/info-extractor.ts` | 使用轻量模型（简单提取任务） |
| `src/agents/gathering-agent.ts` | 使用轻量模型（补全问题） |

**任务路由表**：

| 任务 | 模型 | 理由 |
|------|------|------|
| 偏好提取（InfoExtractor） | Light | 结构化、短文本 |
| 问题生成（GatheringAgent） | Light | 模板化、短文本 |
| 目的地信息（DestinationAgent） | Light | 结构化 JSON |
| 行程生成（LLMPlanAgent） | Full | 长文本、复杂推理 |
| 对话回复（Chat） | Light/Full | 简单问题用 Light，复杂用 Full |
| 搜索结果摘要 | Light | 格式化输出 |

**验收标准**：

- [ ] `callLlm()` 调用日志中能区分使用的模型名称
- [ ] 轻量模型调用占比 > 40%

---

### 3.4 VectorStore 预热与升级阈值

**现状**（`src/rag/vector-store.ts`、`src/rag/embedder.ts`）：

`MemoryVectorStore` 首次搜索时全量加载 11MB JSON（9432 chunks），embedding 查询 + 余弦搜索 O(n)，冷启动有明显延迟。随语料库从 15 城市扩展到 50 城市，线性增长会成问题。

已有 `ChromaStore` 备选实现（`src/rag/chroma-store.ts`），但未定义何时切换。

**目标**：添加预热步骤，定义 ChromaDB 升级阈值。

**改动文件**：

| 文件 | 改动 |
|------|------|
| `src/rag/vector-store.ts` | 应用启动时调用 `warmup()` 预加载 vector store |
| `src/api/app.ts` 或 `src/index.ts` | 启动时调用 `vectorStore.warmup()` |
| `src/rag/chroma-store.ts` | 确认功能完整，可与 MemoryVectorStore 互换 |
| `src/rag/rag-source.ts` | 新增自动切换逻辑：chunk 数量 > 阈值时切到 ChromaDB |

**升级阈值**：

| 条件 | 策略 |
|------|------|
| chunks < 5000 | MemoryVectorStore |
| chunks 5000 ~ 20000 | MemoryVectorStore + 启动预热 |
| chunks > 20000 | ChromaDB（需配置 `RAG_CHROMA_URL`） |
| ChromaDB 不可用 | 自动降级 MemoryVectorStore |

**验收标准**：

- [ ] 应用启动后首次搜索延迟 < 500ms（预热消除冷启动）
- [ ] 环境变量 `RAG_CHROMA_URL` 已配置时优先使用 ChromaDB
- [ ] ChromaDB 不可用时自动降级且有 WARN 日志

---

## 4. 行业对标提升（P3）

### 4.1 Checkpoint 持久化

**现状**（`src/conversation/session-store.ts`、`src/conversation/context.ts`）：

会话状态存储在内存 Map 中，带 TTL 自动过期。服务重启或崩溃后所有会话数据丢失，无法恢复中断的规划流程。

**目标**：引入可选的持久化存储，支持状态机中断恢复。

**方案**：

```
SessionStore 接口
  ├─ MemorySessionStore（当前实现，开发/测试）
  ├─ FileSessionStore（新增，JSON 文件持久化，轻量部署）
  └─ RedisSessionStore（未来，生产环境）
```

**改动文件**：

| 文件 | 改动 |
|------|------|
| `src/conversation/session-store.ts` | 抽象接口，新增 `FileSessionStore` 实现 |
| `src/config/settings.ts` | 新增 `SESSION_STORE_TYPE`（memory/file/redis）和 `SESSION_STORE_PATH` |
| `src/api/routes.ts` | `createSessionStore()` 根据配置选择实现 |

**验收标准**：

- [ ] 配置 `SESSION_STORE_TYPE=file` 后，服务重启会话不丢失
- [ ] 会话状态序列化为 JSON，可人工读取和调试
- [ ] 向后兼容：默认 `memory` 模式行为不变

---

### 4.2 Human-in-the-loop 抽象

**现状**：

系统有 `select` 操作（交通选择、酒店选择），通过 `/api/chat/:sid/select` 接口处理。但没有统一的"需要人工确认"抽象——每个需要用户输入的地方是 ad-hoc 实现的。

**目标**：建立统一的 Human-in-the-loop 抽象层。

**方案**：

```typescript
interface HumanCheckpoint {
  id: string
  type: "transport_select" | "hotel_select" | "budget_override" | "plan_approval"
  prompt: string
  options: CheckpointOption[]
  timeout?: number     // 超时后的默认行为
  fallback: "skip" | "default" | "pause"
}

interface CheckpointOption {
  id: string
  label: string
  description?: string
  preview?: unknown
}
```

**改动文件**：

| 文件 | 改动 |
|------|------|
| `src/conversation/state-machine.ts` | 新增 `WAITING_HUMAN` 状态，统一处理所有人工确认场景 |
| `src/conversation/turn-handler.ts` | `handleTurn()` 返回 `HumanCheckpoint` 替代 ad-hoc select |
| `src/orchestrator/conversation-orchestrator.ts` | 统一处理 checkpoint 的发送和响应 |
| `src/public/chat.html` | 前端组件化渲染不同类型的 checkpoint |

**验收标准**：

- [ ] 所有需要用户确认的环节使用统一的 `HumanCheckpoint` 类型
- [ ] 新增加一个需要确认的步骤只需定义新的 checkpoint type
- [ ] 前端用统一组件渲染 checkpoint，不每种类型单独写 UI

---

### 4.3 端到端 Eval Pipeline

**现状**：

- RAG 有独立 eval（`src/rag/eval.ts`）
- Pipeline 有 error/warning 收集（`state.errorMessages`）
- Trace 有结构化记录（`src/trace-recorder/`）
- 但没有一个统一的评估流水线将这些指标串起来

**目标**：建立端到端评估流水线，从输入到输出全链路测量质量。

**方案**：

```
Eval Pipeline
  Input: 测试用例（偏好 + 期望输出）
    │
    ├─ Phase 1: 工具调用质量
    │   ├─ 数据源响应时间
    │   ├─ 数据源成功率
    │   └─ 降级触发率
    │
    ├─ Phase 2: 行程生成质量
    │   ├─ 景点/餐厅准确性（对比 RAG 语料库）
    │   ├─ 价格真实性（对比数据源返回值）
    │   ├─ 交通衔接完整性
    │   └─ 预算约束满足率
    │
    ├─ Phase 3: 用户体验指标
    │   ├─ 端到端延迟
    │   ├─ 首字延迟（TTFB）
    │   └─ 输出完整率（无截断）
    │
    └─ Output: EvalReport → baseline.jsonl
```

**改动文件**：

| 文件 | 改动 |
|------|------|
| `src/eval/index.ts` | 新增统一评估入口（整合 rag/eval） |
| `src/eval/test-cases.jsonl` | 新增测试用例定义 |
| `src/eval/metrics.ts` | 指标计算工具函数 |
| `data/eval/` | 评估结果和基线数据 |

**验收标准**：

- [ ] `npx tsx src/eval/index.ts` 运行完整评估流水线
- [ ] 输出包含工具层、生成层、体验层三组指标
- [ ] 每次评估结果追加到 baseline.jsonl，支持趋势追踪

---

## 5. 附录：改动文件清单

### 新增文件

| 文件 | 对应条目 |
|------|----------|
| `src/eval/index.ts` | 4.3 |
| `src/eval/test-cases.jsonl` | 4.3 |
| `src/eval/metrics.ts` | 4.3 |
| `data/eval/e2e-queries.jsonl` | 2.1 |

### 修改文件

| 文件 | 对应条目 |
|------|----------|
| `src/orchestrator/parallel.ts` | 1.1 |
| `src/orchestrator/pipeline.ts` | 1.1, 2.1, 2.2 |
| `src/orchestrator/budget-loop.ts` | 1.1, 1.2 |
| `src/agents/flight-agent.ts` | 1.2 |
| `src/agents/hotel-agent.ts` | 1.2 |
| `src/agents/llm-plan-agent.ts` | 1.2, 2.1, 3.1, 3.2 |
| `src/agents/budget-agent.ts` | 1.2 |
| `src/data-sources/amadeus-source.ts` | 1.2 |
| `src/data-sources/booking-source.ts` | 1.2 |
| `src/data-sources/types.ts` | 1.2 |
| `src/types/index.ts` | 1.2, 4.2 |
| `src/api/routes.ts` | 1.3, 4.1 |
| `src/api/stream-handler.ts` | 1.3 |
| `src/tools/registry.ts` | 1.3 |
| `src/public/chat.html` | 1.3 |
| `src/config/settings.ts` | 3.1, 3.2, 3.3, 4.1 |
| `src/conversation/info-extractor.ts` | 3.1, 3.3 |
| `src/agents/destination-agent.ts` | 2.2, 3.1 |
| `src/agents/gathering-agent.ts` | 3.1, 3.3 |
| `src/agents/base-agent.ts` | 3.2, 3.3 |
| `src/rag/eval.ts` | 2.1 |
| `src/rag/vector-store.ts` | 3.4 |
| `src/rag/chroma-store.ts` | 3.4 |
| `src/rag/rag-source.ts` | 3.4 |
| `src/api/app.ts` | 3.4 |
| `src/conversation/session-store.ts` | 4.1 |
| `src/conversation/state-machine.ts` | 4.2 |
| `src/conversation/turn-handler.ts` | 4.2 |
| `src/orchestrator/conversation-orchestrator.ts` | 4.2 |
| `xhs-service/README.md` | 2.3 |

### 删除文件

| 文件 | 对应条目 |
|------|----------|
| `src/agents/destination-agent.ts` | 2.2（类删除，逻辑迁移为函数） |
| `src/api/tools.ts` | 1.3（合并到 tools/registry.ts） |

---

> 实施建议：按优先级 P0 → P1 → P2 → P3 的顺序推进。P0 三个缺陷彼此独立，可并行修改。每个 P0 项完成后单独 commit，便于回滚和 review。
