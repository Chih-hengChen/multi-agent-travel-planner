# Multi-Agent Travel Planner — Node.js 架构文档

## 目录结构

```
src/
├── agents/                    # 6 个领域 Agent + 1 个基类
│   ├── base-agent.ts          # 抽象基类（模板方法 + LLM 调用，支持分层 temperature/maxTokens/model）
│   ├── preference-agent.ts    # 偏好校验
│   ├── flight-agent.ts        # 航班/高铁搜索与评分（支持 searchConstraints 预算约束）
│   ├── hotel-agent.ts         # 酒店搜索与评分
│   ├── activity-agent.ts      # 活动规划（LLMPlanAgent 降级兜底）
│   ├── llm-plan-agent.ts      # LLM 驱动行程生成（主力）
│   ├── budget-agent.ts        # 预算检查 + 自动调整
│   ├── gathering-agent.ts     # 信息收集提问生成
│   └── index.ts               # 统一导出
├── intent-router/             # 意图路由层
│   ├── types.ts               # RouteDecision + ExecutionMode
│   └── index.ts               # IntentRouter 分类器
├── step-executor/             # 统一 Step Runtime
│   ├── types.ts               # AgentStep + StepRecord
│   ├── index.ts               # StepExecutor 生命周期管理
│   └── result-validator.ts    # 工具输出校验器
├── trace-recorder/            # 可观测性 Trace
│   └── index.ts               # TraceRecorder + TraceEvent
├── tools/                     # 工具注册表（LLM tool_use 体系）
│   ├── registry.ts            # ToolRegistry — 注册/执行/超时
│   ├── types.ts               # RegisteredTool / ToolResult
│   ├── definitions/           # 8 个注册工具
│   │   ├── collect-preferences.ts
│   │   ├── plan-travel.ts
│   │   ├── search-xhs.ts
│   │   ├── search-web.ts
│   │   ├── search-trains.ts
│   │   ├── search-flights.ts
│   │   ├── search-hotels.ts
│   │   └── search-attractions.ts
│   └── index.ts
├── orchestrator/              # 编排层
│   ├── pipeline.ts            # 主流水线（Preference → enrichDestination → BudgetLoop，DestinationAgent 内联）
│   ├── parallel.ts            # PipelineExecutor — 支持 runSequential / runParallel（Flight+Hotel 真正并行）
│   ├── budget-loop.ts         # 预算调整循环控制器（飞行+酒店并行 → LLM 计划顺序 → 预算检查）
│   ├── conversation-orchestrator.ts  # 会话编排
│   └── index.ts
├── conversation/              # 多轮对话模块
│   ├── state-machine.ts       # 状态机（INIT → GATHERING → ... → COMPLETED）
│   ├── context.ts             # ConversationContext + 字段合并
│   ├── session-store.ts       # Session 存储（内存 TTL）
│   ├── turn-handler.ts        # 单轮处理（意图路由 → 提取 → 状态推进）
│   └── info-extractor.ts      # 自然语言偏好提取（LLM+正则）
├── api/                       # HTTP + SSE 接口层
│   ├── app.ts                 # Fastify 服务工厂（启动时执行 VectorStore 预热）
│   ├── routes.ts              # 路由注册（REST + SSE，旧 /api/chat/stream 已移除）
│   ├── llm-client.ts          # Anthropic 流式 API 客户端
│   └── stream-handler.ts      # SSE 聊天主逻辑（仅会话入口，旧 agent loop 已移除）
├── data-sources/              # 数据源层（全部真实来源，无 mock）
│   ├── types.ts               # TravelDataSource 接口
│   ├── source-resolver.ts     # 数据源选择器（per-source 超时 + fallback 链）
│   ├── fallback-data-source.ts# 双源降级包装器
│   ├── amadeus-source.ts      # 携程航班 API（Ctrip 低价查询）
│   ├── booking-source.ts      # Booking.com 酒店 API（RapidAPI）
│   ├── amap-source.ts         # 高德 POI 搜索（景点/餐厅/公交路线规划）
│   ├── amap-weather-source.ts # 高德天气（实时+预报）
│   ├── web-search-source.ts   # 搜索引擎（百度>sogou>bing>Firecrawl兜底）
│   └── train12306-source.ts   # 12306 火车票查询（JSON-RPC over stdio）
├── rag/                       # RAG 旅行攻略检索
│   ├── types.ts               # RagDocument / RagSearchParams / RagSearchResult
│   ├── embedder.ts            # Embedding API 调用（LRU 缓存）
│   ├── vector-store.ts        # IVectorStore + MemoryVectorStore（文件持久化）
│   ├── chroma-store.ts        # ChromaDB 实现（备选）
│   ├── corpus-loader.ts       # 文档分块（三级递进）
│   ├── pdf-loader.ts          # PDF 文本提取
│   ├── rag-source.ts          # RagSource 统一入口（向量→关键词兜底）
│   ├── ingest.ts              # 离线入库脚本
│   └── eval.ts                # 评估脚本
├── config/
│   └── settings.ts            # 环境变量配置（frozen object）
├── logging/
│   ├── session-context.ts     # AsyncLocalStorage session 上下文
│   └── session-logger.ts      # 结构化 session 日志（JSONL）
├── cli/
│   └── index.ts               # commander CLI 入口
└── public/
    └── chat.html              # SSE 前端（Tailwind + marked.js）
```

## 核心数据流

### 多轮对话流（新主入口）

```
浏览器 chat.html
  │  POST /api/chat → { sessionId }
  │  POST /api/chat/:sid (SSE) → { message }
  │  POST /api/chat/:sid/select (SSE) → { type, outboundId, returnId, hotelId }
  ▼
ConversationOrchestrator :: handleMessage(sid, msg, emit) / handleSelect(sid, req, emit)
  │  load ConversationContext from SessionStore
  ▼
TurnHandler :: handleTurn(ctx, userMessage)
  │
  │  1. IntentRouter.route(msg, knownFields) → RouteDecision
  │     │  intent: plan_travel | add_info | simple_answer | chitchat | error
  │     ▼
  │  2. InfoExtractor.extract(msg, history, knownFields) → ExtractedFields
  │     │  LLM prompt → JSON 解析 + 字段校验
  │     ▼
  │  3. mergeExtracted(ctx, extracted) → 更新 ctx
  │
  │  4. advanceState(ctx) → 检查字段完整性推进状态
  │     │  INIT → GATHERING_BASICS → GATHERING_PREFERENCES
  │     │  → SEARCHING_TRANSPORT → SELECTING_TRANSPORT
  │     │  → SEARCHING_HOTELS → SELECTING_HOTEL → SEARCHING → COMPLETED
  │     ▼
  │  5a. GATHERING 阶段 → GatheringAgent.generateQuestion(ctx)
  │     → SSE: text_delta + question { text, fields }
  │
  │  5b. SEARCHING_TRANSPORT → SourceResolver 搜索交通
  │     → SSE: text_delta + transport_options
  │
  │  5c. 用户 POST /select { type: transport } → handleSelect()
  │     → SEARCHING_HOTELS → SourceResolver 搜索酒店
  │     → SSE: text_delta + hotel_options
  │
  │  5d. 用户 POST /select { type: hotel } → handleSelect()
  │     → SEARCHING → Pipeline.run(prefs) → buildPlanSummary
  │     → SSE: text_delta + tool_result { plan }
  ▼
ConversationOrchestrator → emit SSE events → save ctx → SessionStore
```

**SSE 事件类型（多轮对话）**:

| 事件 | 数据 |
|------|------|
| `text_delta` | `{ text: "..." }` |
| `state_change` | `{ state: "GATHERING_BASICS" }` |
| `question` | `{ text, fields: ["startDate", "endDate"] }` |
| `transport_options` | `{ outbound: TransportOption[], return: TransportOption[] }` |
| `hotel_options` | `Hotel[]` |
| `tool_result` | `{ tool: "plan_travel", result: PlanSummary }` |
| `error` | `{ error: "message", recoverable: true }` |
| `done` | `{}` |

> 旧入口 `POST /api/chat/stream` 已移除（2026-06-08 架构改进）。所有会话交互统一走 `/api/chat` 创建会话 + `/api/chat/:sid` 流式消息。

### Pipeline 内部执行流

```
UserPreferences
  │
  ▼
[PreferenceAgent] ─── 校验 preferences 非空
  │  state → RECOMMENDING_DESTINATIONS
  ▼
[enrichDestination()] ── LLM 生成目的地信息（原 DestinationAgent 内联为纯函数）
  │  使用 LLM_LIGHT_MODEL + LLM_TEMPERATURE_STRUCTURED（0.1）保证 JSON 稳定性
  │  失败返回兜底对象
  ▼
[BudgetLoopController] ── 最多 3 轮循环
  │
  │  ┌─ [真正并行执行] ──────────────────────┐
  │  │  Promise.allSettled([                  │
  │  │    FlightAgent,    ← 无数据依赖        │
  │  │    HotelAgent      ← 可同时执行        │
  │  │  ])                                    │
  │  │  → 各自 120s 超时 → 1.5x 重试 → 降级  │
  │  └────────────────────────────────────────┘
  │                    ▼
  │  ┌─ [顺序执行 LLM 计划] ─────────────────┐
  │  │  LLMPlanAgent（依赖前两者结果）        │
  │  │  ← 120s 超时 → 1.5x 重试 → 降级      │
  │  └────────────────────────────────────────┘
  │                    ▼
  │  [BudgetAgent] ── 汇总费用
  │     ├── 预算内 → COMPLETED
  │     ├── 超预算 & round < max → ADJUSTING，重新搜索（searchConstraints 传递到数据源）
  │     └── 超预算 & round ≥ max → COMPLETED + warnings
  └────────────────────┘
         │
         ▼  LLMPlanAgent 降级时启用兜底
    [ActivityAgent] ── 真实数据源的算法式活动规划
         │
         ▼
    TravelPlanState (完整行程)
```

### Runtime Agent Loop（新架构，替代旧 Pipeline）

```
Agent Loop (src/runtime/agent-loop.ts)
  │  phase: gathering → searching → selecting → planning → completed
  │
  ├─ gathering: InfoExtractor 提取偏好 → advanceState
  ├─ searching: LLM 并行调 search_flights/search_hotels/search_attractions/...
  │    → candidateTransports + candidateHotels 齐全 → selecting
  ├─ selecting: LLM 展示候选文本 → loop 暂停 pausedForSelection
  │    → 前端 POST /select → applyUserSelection() → maybeAdvancePhase
  │    → selected* 齐全 → planning（恢复 agent loop）
  ├─ planning: LLM 调 search_attractions/search_restaurants/plan_transit
  │    → 最后调 finalize_plan(rawJson=完整 JSON) → dayPlans + budgetBreakdown
  │    → maybeAdvancePhase → completed
  └─ completed: canFinish → 返回 TurnResult + planResult
```

**红线守卫**: `select_transport`/`select_hotel` 的 `allowedPhases:[]`，LLM 在任何阶段不可调用。仅 `/api/chat/:sid/select` API 可注入选择。

**工具策略** (`src/tools/policy.ts`): 每个工具按 phase 控制可用性。`isToolAllowedInPhase()` 在 agent loop 内过滤工具列表。

**plan_transit**: 不调 geocode API。先 `findCoordsByName`（模糊匹配 POI 坐标），找不到直接 haversine 距离估算。避免地名无法解析导致的 100% 失败率。

**finalize_plan**: Zod `TravelPlanSchema` 验证 → 质量自检（连锁品牌、本地特色占比、transitToNext）→ 写入 `dayPlans`/`budgetBreakdown`。

**关键文件**:
| 文件 | 职责 |
|------|------|
| `src/runtime/agent-loop.ts` | 主循环（30 iter max, 10 stale max, JSON repair ×3） |
| `src/runtime/state.ts` | AgentState + maybeAdvancePhase + applyUserSelection + computeTravelDays |
| `src/runtime/system-prompt.ts` | 分 phase 系统提示词（含 TravelPlanSchema 格式示例） |
| `src/runtime/validate-tool-calls.ts` | 工具调用校验（phase 权限 + 前置条件 + schema） |
| `src/runtime/apply-tool-effects.ts` | 工具结果写入 state（含 finalize_plan reducer） |
| `src/runtime/tool-adapter.ts` | buildTools() 注册 + 特化 executor 调度 |
| `src/tools/policy.ts` | TOOL_PHASE_POLICY + 工具 fallback 链 |
| `src/tools/schemas/` | Zod schema（TravelPlan/Activity/ItinerarySlot/DiningPlan 等） |

## 数据源体系

全部数据源均为真实 API，无任何 mock 数据集：

| 数据源 | 用途 | 实现 |
|--------|------|------|
| **携程航班** (`AmadeusSource`) | 航班低价查询 | `flights.ctrip.com` REST API |
| **Booking.com** (`BookingSource`) | 酒店搜索 | RapidAPI |
| **高德 POI** (`AmapSource`) | 景点/餐厅/公交路线 | 高德地图 Web API |
| **12306 MCP** (`Train12306Source`) | 火车票查询 | JSON-RPC over stdio |
| **高德天气** (`AmapWeatherSource`) | 实时+预报天气 | 高德天气 API |
| **WebSearch** (`WebSearchSource`) | 搜索引擎降级 | 百度>sogou>Bing>Firecrawl |
| **RAG 攻略** (`RagSource`) | 旅行攻略语义检索 | Embedding 向量+关键词兜底 |
| **XHS 小红书** | 旅游笔记 | Python FastAPI 微服务（封装 Spider_XHS） |

### 降级策略

```typescript
// FallbackDataSource 组合主+备用数据源
new FallbackDataSource(
  primary: AmadeusSource(航班) / BookingSource(酒店) / AmapSource(景点) / Train12306Source(火车),
  fallback: WebSearchSource,
  logger,
)
```

链路：主数据源返回空或异常 → WebSearch 搜索引擎降级 → 仍失败则返回空数组。

## Agent 实现细节

### BaseAgent（抽象基类）

```typescript
abstract class BaseAgent {
  abstract readonly name: string
  protected abstract execute(state: TravelPlanState): Promise<TravelPlanState>

  run(state)           // 模板方法：try/catch 包裹 execute
  callLlm(prompt)      // LLM 调用入口
  anthropicLlm()       // POST /v1/messages (Anthropic API)
  openaiLlm()          // POST /chat/completions (OpenAI 兼容 API)
}
```

**设计**: `run()` 是 public 模板方法，`execute()` 是 protected 子类实现。异常不向上抛出，降级到 `state.errorMessages`，保证 pipeline 不中断。

### PreferenceAgent

校验 `state.preferences` 非空，推进 state。不处理任何数据。

### ~~DestinationAgent~~ → enrichDestination()（内联纯函数）

> 2026-06-08 重构：从 BaseAgent 子类降级为普通工具函数 `enrichDestination(city, budget)`，内联到 Pipeline。原因：该类无工具调用、无决策逻辑、不写入 state 之外的字段，不应是一个 Agent。

使用 `LLM_LIGHT_MODEL` + `LLM_TEMPERATURE_STRUCTURED(0.1)` 生成目的地信息（国家、描述、最佳季节、签证要求、安全评分、消费水平、亮点）。失败时返回仅有 city 的兜底对象。

### FlightAgent

- **用户已选择交通**（`selectedOutbound/selectedReturn`）→ 直接使用，跳过搜索
- **同城旅行**（出发=目的地）→ 不搜索，交通费为0
- **偏好高铁** → 调 Train12306Source + `bestTrain()` 评分选最优
- **无偏好** → 先搜高铁；高铁无结果时降级到航班
- **偏好航班** → 调 Ctrip 航班 API + `bestFlight()` 评分选最优

**评分公式** (bestFlight):
```
priceScore × 50 + durationScore × 30 + stopsScore × 20 + budgetBonus
```

**注意**: Ctrip API 返回该航线的最低票价，FlightAgent 基于该价格合成 4 个具体航班（航司、班次、时刻随机），并非真正的逐班搜索。

### HotelAgent

- **用户已选择酒店** → 直接使用
- **未选择** → 调 BookingSource（RapidAPI）+ `bestHotel()` 评分选最优

**评分公式**:
```
priceWithinBudget(20) + starMatch(30) + userRating×3 + distanceScore + brandBonus(15)
```

### LLMPlanAgent（行程生成主力）

LLM 驱动的 ReAct 循环 Agent（最多 10 轮），自主决定调用哪些工具：

```
LLMPlanAgent.execute()
  │  getCityKnowledge(WebSearch) + getFullWeather(高德)
  │  → 注入 system prompt
  ▼
  for round 0..9:
    callLlmWithTools(messages, tools)
    ├── LLM 返回 text → 无 tool_use → 解析 JSON → DayPlan
    └── LLM 返回 tool_use → 执行工具 → tool_result 回传 → 继续循环

  工具：
  ├─ search_weather        ── 高德天气 API
  ├─ search_attractions    ── 高德 POI 景点搜索（12条上限）
  ├─ search_restaurants    ── 高德 POI 餐厅搜索（8条上限）
  ├─ search_travel_guides  ── RAG 攻略语义检索
  └─ search_xhs_notes     ── 小红书笔记（Python 微服务）
```

**上下文管理**: 超出 100K 字符时执行"头+摘要+尾"压缩。解析失败时 `fallbackPlanDays()` 返回硬编码模板行程。

**强制工具调用** (`MIN_TOOL_CALLS = 4`):LLM 输出 text 但 `totalToolCalls < 4` 或 `hasKeyData`(attractions + dining + xhs)未齐时,Agent 会 push `【强制】检测到你未调用足够工具...` 的 user 消息逼 LLM 继续调工具,避免 LLM 凭空捏造行程。

**Checkpoint 跨实例恢复**:每轮开始把 `{messages, toolCallHistory, hasSearched*, totalToolCalls, round}` 写入 `state.llmPlanCheckpoint`。`PipelineExecutor` 超时重试时会 `structuredClone(state)` 快照 + `restoreState()` 恢复,新 LLMPlanAgent 实例从 checkpoint 续行而非从零开始(避免超时累计放大)。

**上限**:`maxRounds = 10`,超出走 `fallbackPlan`(mock 4 活动/天)。

### ActivityAgent（LLMPlanAgent 降级兜底）

**只当 LLMPlanAgent 超时/失败时启用**。算法式规划：

- 调高德 POI 搜索景点和餐厅
- `mustVisitAttractions` 优先搜索，按索引循环分配
- `planOneDay()` 按 morning/afternoon/evening 分配景点+餐厅
- `buildTransitSegments()` 基于 Haversine 距离计算市内交通

**降级硬编码**: 餐厅API返回空时 fallback 到固定餐费（早¥30/午¥60/晚¥80），交通规划失败时固定¥40。

### BudgetAgent

```
total = flightCost + hotelCost + activityCost
remaining = budget - total

if remaining >= 0:
    → COMPLETED
elif round < maxAdjustments(3):
    → ADJUSTING, computeConstraints() 生成更紧的搜索约束
      FlightAgent/HotelAgent 读取 searchConstraints 重新搜索真实低价
      （不再是纸面降价，而是带 maxPrice 参数重新调用数据源）
else:
    → COMPLETED + warnings
```

### GatheringAgent（对话信息收集）

多轮对话中生成自然语言提问，引导用户补充缺失的旅行偏好字段（目的地、日期、预算等）。

使用 `LLM_LIGHT_MODEL` + `LLM_TEMPERATURE_CHAT(0.6)` 控制对话质量。

## 工具注册表 (ToolRegistry) — ⚠️ 当前为死代码

**`src/tools/registry.ts`** + `tools/index.ts` + `tools/definitions/*.ts` + `api/tools.ts` 共同构成 ToolRegistry 体系(8 个工具):

| 工具 | 说明 | 超时 |
|------|------|------|
| `collect_preferences` | 触发前端偏好采集弹窗 | - |
| `plan_travel` | 调用完整 Pipeline | 120s |
| `search_xhs_notes` | 小红书笔记搜索 | - |
| `search_web` | 网页搜索 | - |
| `search_trains` | 火车票查询 | - |
| `search_flights` | 航班查询 | - |
| `search_hotels` | 酒店查询 | - |
| `search_attractions` | 景点搜索 | - |

> **现状(2026-06-16 审计)**:该体系目前**未被任何活路径调用**。`api/tools.ts` 创建了 `registry` 单例并 export `TOOLS` / `executeTool`,但 `stream-handler.ts` 和其他模块均未 import。当前对话+行程生成实际走的工具体系是 `LLMPlanAgent.buildToolDefs()` 内联定义的 5 工具(见下文 LLMPlanAgent 小节)。两套工具的 `search_attractions` / `search_xhs_notes` 存在 schema 漂移风险。**建议:删除 ToolRegistry 死代码,或恢复 chat 流对其的调用。**

## 状态机

### Pipeline 状态机 (PlanningState)

```
COLLECTING_PREFERENCES → RECOMMENDING_DESTINATIONS → BUDGET_CHECKING
                                                         │
                                              ┌──────────┤
                                              ▼          ▼
                                           ADJUSTING   COMPLETED
                                              │
                                              └──→ (最多 3 轮)
```

### 对话状态机 (ConversationState)

```
                        ┌──────────────────────────────────┐
                        │  ERROR_RECOVERABLE               │
                        │  （可重试 2 次）                  │
                        └────────┬─────────────────────────┘
                                 │
INIT → GATHERING_BASICS → GATHERING_PREFERENCES
  │                                    │
  │                          SEARCHING_TRANSPORT
  │                              │
  │                     SELECTING_TRANSPORT
  │                              │（用户选择或重新搜索）
  │                      SEARCHING_HOTELS
  │                              │
  │                       SELECTING_HOTEL
  │                              │（用户选择或更换交通）
  │                         SEARCHING
  │                              │
  │                          COMPLETED
  │                              │
  └──（用户可继续修改偏好重新规划）
```

## 编排层细节

### PipelineExecutor（原 ParallelExecutor）

**已改为真正并行执行**（2026-06-08 架构改进）：

```typescript
// 无数据依赖：FlightAgent + HotelAgent 同时运行
const settled = await Promise.allSettled(
  this.agents.map((agent) => this.runSingle(agent, state)),
);
```

**执行策略**:
- `runParallel()` — 用于 FlightAgent + HotelAgent（无数据依赖，可同时搜索），延迟降低 40-50%
- `runSequential()` — 用于 LLMPlanAgent（依赖前两者结果）

**关键特性**: 每个 agent 独立超时(120s) → 重试(1.5x) → 降级。部分 agent 失败不阻塞整体 pipeline。

**状态快照与恢复** (`runSingle`):
1. 执行前 `structuredClone(state)` 拍快照
2. 首次尝试失败(尤其是超时)→ `restoreState(state, snapshot)` 把 state 字段(7 个数据字段 + errorMessages + searchConstraints 等)逐字段拷回
3. 以 1.5x 超时重试一次
4. 仍失败 → 标记 `degraded = true` 但 `success = true`,让 pipeline 继续

> 关键不变量:重试时 state 必须回到首次执行前的形态,否则 Agent 在脏数据上重试会放大错误。LLMPlanAgent 额外通过 `state.llmPlanCheckpoint` 续行 ReAct 循环。

### 价格漂移校验 (refreshSelectedPrices)

Pipeline 在 `enrichDestination` 之后、`budgetLoop` 之前调用 `refreshSelectedPrices(state)`,对用户已选的 `selectedOutbound / selectedReturn / selectedHotel` 重新查价:

```
对每个 selected 条目:
  fresh = dataSource.searchFlights/searchHotels(...)
  match = fresh.find(同航班号/同名酒店)
  if |match.price - selected.price| / selected.price > 10%:
      state.priceWarnings.push("去程 CA1234 价格已从 ¥800 变为 ¥950 (+19%)")
      pref[key] = match   // 用最新价覆盖用户选择
```

> 目的:用户在 SELECTING_TRANSPORT/HOTEL 阶段选完后,到 Pipeline 真正执行可能间隔数十秒,期间数据源价格可能变化。>10% 漂移生成 warning 并更新价格,避免最终预算计算基于过期数据。校验失败不阻塞 pipeline(catch 吞错)。

### BudgetLoopController

```typescript
for (let attempt = 0; attempt <= maxRetries(3); attempt++) {
  // 真正并行 FlightAgent + HotelAgent
  const { state: searchState } = await this.flightHotelExecutor.runParallel(state);
  // 再顺序执行 LLMPlanAgent
  const { state: planState } = await this.planExecutor.runSequential(searchState);
  // 预算检查
  state = await this.budgetAgent.run(planState);
  if (COMPLETED || FAILED) return state;
  // ADJUSTING → 继续下一轮（searchConstraints 传递到数据源重新搜索）
}
```

### 降级恢复机制

```
LLMPlanAgent 失败（超时/异常）
  → 记录 recovery_action(degraded)
  → Pipeline 检测 activityResult 为空
  → 降级到 ActivityAgent.run()（算法式规划）
  → ActivityAgent 也失败 → 记录错误，继续返回
```

## 会话持久化 (SessionStore)

`SessionStore` 接口 4 个方法:`get / set / delete / refreshTtl`。两种实现:

| 实现 | 触发条件 | 存储 | 持久化语义 |
|------|----------|------|-----------|
| `MemorySessionStore` | `SESSION_STORE_TYPE=memory`(默认) | `Map<sid, {ctx, expiresAt}>` | 进程内,重启丢失 |
| `FileSessionStore` | `SESSION_STORE_TYPE=file` | `data/sessions/{sid}.json` | 进程重启不丢失 |

**共同机制**:
- TTL 默认 2h(`SESSION_TTL_MS`),60s 扫描清理过期
- `get()` 返回 `structuredClone(ctx)`,防止调用方污染存储内 ctx
- **乐观锁**:每次 `set` 时校验 `current.version === ctx.version - 1`,不匹配抛 `VersionConflictError`。`version` 由 `ConversationOrchestrator` 自增。

**FileSessionStore 原子写**:`writeFileSync(tmpPath)` → `renameSync(tmpPath, filePath)`,避免半写状态被读到。`sweep()` 扫描目录中所有 `.json`,过期文件 `unlinkSync`,损坏文件静默跳过。

**ConversationContext 字段**:sessionId / state / version / createdAt / updatedAt / messageHistory / turnCount,加业务字段(destination / departureCity / startDate / endDate / numTravelers / budget / transportSearchResult / hotelOptions / selectedOutboundId / selectedReturnId / selectedHotel / planSummary / editedPlanSummary / lastError 等)。

## RAG 旅行攻略检索

### 数据流

```
PDF 文件（129 个，全国 15 地区）
  │  pdf-loader.ts（pdf-parse 提取文本）
  ▼
纯文本攻略
  │  corpus-loader.ts chunkDocument()
  │  三级分块：## 标题 → \n\n 段落 → 滑窗
  │  参数：maxChars=500, overlap=80, minChars=100
  ▼
9,432 个文档块
  │  embedder.ts（智谱 embedding-3, 2048 维）
  ▼
实数向量
  │  MemoryVectorStore（or ChromaDB 备选）
  ▼
data/vectors/travel_guides.json（11MB 持久化）
```

### 搜索链路

```
Agent 调用 search_travel_guides(city, query)
  │
  ▼
RagSource.search()
  │  1. Embedding API → query 向量（2048 维）
  │  2. MemoryVectorStore 余弦相似度搜索
  │  3. score ≥ 0.3 → 返回向量结果
  │  4. score < 0.3 → 关键词兜底
  │     （单字 + 双字切分，按词频归一化计分）
  ▼
RagSource.formatForLlm() → 格式化文本注入 LLM 上下文
```

### 配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `RAG_ENABLED` | `true` | 开关 |
| `RAG_EMBEDDING_BASE_URL` | `LLM_BASE_URL` | Embedding API 地址 |
| `RAG_EMBEDDING_API_KEY` | `LLM_API_KEY` | Embedding API 密钥 |
| `RAG_EMBEDDING_MODEL` | `text-embedding-3-small` | 嵌入模型名 |
| `RAG_CHROMA_URL` | `""` | ChromaDB 地址（空=用 MemoryVectorStore）|
| `RAG_PDF_DIR` | `""` | PDF 语料目录 |

## API 层

### SSE 流式聊天

**`llm-client.ts`** — 底层 Anthropic API 客户端：

```typescript
streamChat(messages, tools?, system?, onDelta?) → Promise<ChatResult>

// SSE 解析：content_block_start → content_block_delta(input_json_delta/text_delta)
// → content_block_stop → message_stop
```

**`stream-handler.ts`** — SSE 聊天主逻辑（仅保留会话入口 `handleConversationMessage` 和 `handleSelectMessage`，旧 `handleChatStream` + `runAgentLoop` 已移除）。工具调用统一走 `tools/registry.ts`。

### REST 路由

| 方法 | 路径 | 用途 |
|------|------|------|
| POST | `/api/chat` | 创建新会话 |
| POST | `/api/chat/:sid` | 发送消息（SSE） |
| POST | `/api/chat/:sid/select` | 选择交通/酒店（SSE） |
| GET | `/api/chat/:sid` | 获取会话状态 |
| DELETE | `/api/chat/:sid` | 删除会话 |
| PUT | `/api/chat/:sid/plan` | 编辑行程计划 |
| POST | `/api/plan` | 一键计划（完整 Pipeline） |
| POST | `/api/plan/full` | 一键计划（完整 TravelPlanState） |

### 前端 (`chat.html`)

- Tailwind CSS + marked.js CDN
- SSE 多轮对话：text_delta → question → transport_options → hotel_options → tool_result
- 行程时间线渲染：`renderTimelineStop` / `renderTimelineTransit` / `renderReferenceSources`
- 编辑模式：拖拽排序、删除活动、添加备注、跨日移动

## 类型系统

所有类型通过 **Zod Schema** 定义在 `types/index.ts`，同时推导 TypeScript 类型：

```
UserPreferencesSchema  → UserPreferences
DestinationSchema      → Destination
FlightSchema           → Flight
HotelSchema            → Hotel
ActivitySchema         → Activity
DayPlanSchema          → DayPlan
BudgetBreakdownSchema  → BudgetBreakdown
PlanSummarySchema      → PlanSummary (+ PlanReference)
TrainSchema            → Train
```

## 配置

通过 `.env` 环境变量配置，`settings.ts` 加载并冻结：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LLM_PROVIDER` | `openai` | 兼容 OpenAI/Anthropic API |
| `LLM_API_KEY` | - | API 密钥 |
| `LLM_BASE_URL` | `https://api.minimax.chat/v1` | API 地址 |
| `LLM_MODEL` | `MiniMax-M2.7` | 模型名 |
| `LLM_LIGHT_MODEL` | `glm-4.7` | 轻量模型 |
| `LLM_TEMPERATURE` | `0.7` | 生成温度（默认，向后兼容） |
| `LLM_TEMPERATURE_STRUCTURED` | `0.1` | 结构化任务温度（InfoExtractor, enrichDestination） |
| `LLM_TEMPERATURE_CREATIVE` | `0.7` | 创意任务温度（LLMPlanAgent 行程生成） |
| `LLM_TEMPERATURE_CHAT` | `0.6` | 对话任务温度（GatheringAgent） |
| `LLM_MAX_TOKENS` | `4096` | 默认最大 token 数 |
| `LLM_MAX_TOKENS_PLAN` | `8192` | LLMPlanAgent 行程生成最大 token 数 |
| `BUDGET_MAX_RETRIES` | `3` | 预算调整最大轮次 |
| `API_HOST` | `0.0.0.0` | 监听地址 |
| `API_PORT` | `3000` | 监听端口 |
| `LOG_LEVEL` | `info` | 日志级别 |
| `SESSION_TTL_MS` | `7200000` | 会话 TTL（2h）|
| `WEBSEARCH_DAEMON_URL` | `http://127.0.0.1:3210` | WebSearch 后端地址 |
| `FIRECRAWL_API_KEY` | - | Firecrawl 兜底搜索 |
| `XHS_SERVICE_URL` | `http://127.0.0.1:3220` | 小红书搜索微服务 |
| `TRAIN_12306_ENABLED` | `true` | 12306 火车开关 |
| `RAG_ENABLED` | `true` | RAG 攻略开关 |
| `RAPIDAPI_KEY` | - | Booking.com API 密钥 |
| `AMAP_API_KEY` | - | 高德 API 密钥 |
