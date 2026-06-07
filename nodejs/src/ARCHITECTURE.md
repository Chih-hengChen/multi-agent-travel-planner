# Multi-Agent Travel Planner — Node.js 架构文档

## 目录结构

```
src/
├── agents/                    # 6 个领域 Agent
│   ├── base-agent.ts          # 抽象基类（模板方法 + LLM 调用）
│   ├── preference-agent.ts    # 偏好补全
│   ├── destination-agent.ts   # 目的地推荐（LLM 生成）
│   ├── flight-agent.ts        # 航班搜索与评分
│   ├── hotel-agent.ts         # 酒店搜索与评分
│   ├── activity-agent.ts      # 每日活动规划
│   ├── budget-agent.ts        # 预算检查 + 自动调整
│   ├── llm-plan-agent.ts      # LLM 驱动行程生成
│   ├── gathering-agent.ts     # 信息收集提问生成
│   └── index.ts               # 统一导出
├── intent-router/             # [新] 意图路由层
│   ├── types.ts               # RouteDecision + ExecutionMode
│   └── index.ts               # IntentRouter 分类器
├── step-executor/             # [新] 统一 Step Runtime
│   ├── types.ts               # AgentStep + StepRecord
│   ├── index.ts               # StepExecutor 生命周期管理
│   └── result-validator.ts    # [新] 工具输出校验器
├── trace-recorder/            # [新] 可观测性 Trace
│   └── index.ts               # TraceRecorder + TraceEvent
├── orchestrator/              # 编排层
│   ├── pipeline.ts            # 主流水线（Preference → Destination → BudgetLoop）
│   ├── parallel.ts            # 并行执行器（Promise.allSettled）
│   ├── budget-loop.ts         # 预算调整循环控制器
│   ├── conversation-orchestrator.ts  # 会话编排（handleMessage + handleSelect）
│   └── index.ts
├── api/                       # HTTP + SSE 接口层
│   ├── app.ts                 # Fastify 服务工厂
│   ├── routes.ts              # 路由注册（REST + SSE）
│   ├── llm-client.ts          # Anthropic 流式 API 客户端
│   ├── tools.ts               # tool_use schema + executeTool
│   └── stream-handler.ts      # SSE 聊天主逻辑（agent loop）
├── types/
│   └── index.ts               # Zod Schema + TypeScript 类型
├── data-sources/              # 数据源层
│   ├── types.ts               # TravelDataSource 接口 + 搜索参数类型
│   ├── source-resolver.ts     # 数据源选择器（per-source 超时 + fallback 链）
│   ├── fallback-data-source.ts # 双源降级包装器
│   ├── amadeus-source.ts      # Amadeus 航班 API
│   ├── booking-source.ts      # Booking.com 酒店 API
│   ├── amap-source.ts         # 高德 POI 搜索
│   └── web-search-source.ts   # Web Search 通用降级
├── rag/                       # RAG 旅行攻略检索
│   ├── types.ts               # RagDocument / RagSearchParams / RagSearchResult
│   ├── embedder.ts            # Embedding API 调用（智谱 embedding-3, LRU 缓存）
│   ├── vector-store.ts        # IVectorStore 接口 + MemoryVectorStore（文件持久化）
│   ├── chroma-store.ts        # ChromaDB 实现（备选，需 server 运行）
│   ├── corpus-loader.ts       # 文档分块（三级递进：标题→段落→滑窗）
│   ├── pdf-loader.ts          # PDF 文本提取（pdf-parse）
│   ├── rag-source.ts          # RagSource 统一入口（混合搜索：向量→关键词兜底）
│   ├── ingest.ts              # 离线入库脚本
│   └── eval.ts                # 评估脚本（Hit Rate / MRR / Recall / 延迟）
├── config/
│   └── settings.ts            # 环境变量配置（frozen object）
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
  │  1. InfoExtractor.extract(msg, history, knownFields) → ExtractedFields
  │     │  mock: 正则提取城市/日期/预算/人数/交通偏好
  │     │  LLM: prompt → JSON 解析 + 字段校验
  │     ▼
  │  2. mergeExtracted(ctx, extracted) → 更新 ctx 字段
  │
  │  3. advanceState(ctx) → 检查字段完整性推进状态
  │     │  INIT → GATHERING_BASICS (有 destination)
  │     │  GATHERING_BASICS → GATHERING_PREFERENCES (basics 齐全)
  │     │  GATHERING_PREFERENCES → SEARCHING_TRANSPORT (preferences 齐全 or maxTurns)
  │     ▼
  │  4a. 仍在 GATHERING → GatheringAgent.generateQuestion(ctx)
  │     → SSE: text_delta + question { text, fields }
  │
  │  4b. 推进到 SEARCHING_TRANSPORT → SourceResolver 搜索交通
  │     → 缓存 transportSearchResult → SELECTING_TRANSPORT
  │     → SSE: text_delta + transport_options
  │
  │  4c. 用户 POST /select { type: transport } → handleSelect()
  │     → 记录选择 → SEARCHING_HOTELS → SourceResolver 搜索酒店
  │     → 缓存 hotelOptions → SELECTING_HOTEL
  │     → SSE: text_delta + hotel_options
  │
  │  4d. 用户 POST /select { type: hotel } → handleSelect()
  │     → 记录选择 → SEARCHING → Pipeline.run(prefs) → buildPlanSummary
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

### 对话式聊天流（旧入口，仍可用）

```
浏览器 chat.html
  │  POST /api/chat/stream (SSE)
  ▼
stream-handler.ts :: handleChatStream()
  │  解析 { message, messages[] }
  │  SSE 握手 (text/event-stream)
  ▼
runAgentLoop() ──── 最多 5 轮
  │
  │  streamChat(messages, TOOLS, SYSTEM_PROMPT)
  │     │  fetch POST /v1/messages (stream: true)
  │     │  解析 SSE：text_delta / input_json_delta / content_block_stop
  │     │  返回 { events[], assistantContent[] }
  │     ▼
  │  LLM 返回 text_delta → 直接 SSE 转发浏览器
  │  LLM 返回 tool_use → executeTool()
  │     │
  │     ▼
  │  tools.ts :: executeTool("plan_travel", input)
  │     │  构建 UserPreferences（含 preferredDestination）
  │     │  调用 TravelPlanningPipeline.run()
  │     │  返回 PlanSummary JSON
  │     ▼
  │  tool_result 写入 messages → 再次调用 streamChat
  │  LLM 基于 tool_result 生成最终回复 → SSE 流式输出
  ▼
浏览器渲染：marked.js Markdown + 行程卡片
```

### Pipeline 内部执行流

```
UserPreferences
  │
  ▼
[PreferenceAgent] ─── 补全 interests 默认值
  │  state → RECOMMENDING_DESTINATIONS
  ▼
[DestinationAgent] ── LLM 生成 or Mock 评分选择
  │  有 preferredDestination → callLlm() → JSON 解析
  │  无 → pickFromMock()（预算+季节+风格+签证 评分排序）
  │  state → SEARCHING_PARALLEL
  ▼
[BudgetLoopController] ── 最多 3 轮循环
  │
  │  ┌─ [ParallelExecutor] ──────────────────────────┐
  │  │  Promise.allSettled([                          │
  │  │    FlightAgent.run(state),                     │
  │  │    HotelAgent.run(state),                      │
  │  │    ActivityAgent.run(state),                   │
  │  │  ])                                            │
  │  │  每个 agent 单独超时 30s，失败不影响其他         │
  │  └────────────────────────────────────────────────┘
  │                    ▼
  │  [BudgetAgent] ── 汇总三项费用
  │     total = flight + hotel + activity
  │     ├── 预算内 → COMPLETED
  │     ├── 超预算 & round < max → ADJUSTING, 按比例削减
  │     └── 超预算 & round ≥ max → COMPLETED + warnings
  │                    │
  │  state == ADJUSTING → 重新并行搜索（削减后的参数）
  └────────────────────┘
         │
         ▼
    TravelPlanState (完整行程)
```

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

### LLMPlanAgent 集成

- **工具名**: `search_travel_guides`
- **位置**: LLMPlanAgent 第 5 个 ReAct 工具（search_weather → search_attractions → search_travel_guides → search_restaurants → search_xhs_notes）
- **区别**: search_attractions 返回实时 POI 列表，search_travel_guides 返回深度攻略文本

### 评估体系

```
eval.ts — 19 条测试查询覆盖 9 城市
  │  指标：Hit Rate / MRR / Recall@10 / 延迟（P50/P95）
  │
  ▼
data/eval/baseline.jsonl（历史记录）
data/eval/RAG系统优化日志.md（优化实验文档）
```

**当前基线**: Hit Rate 71.8% | MRR 0.4868 | P95 延迟 206ms

### 配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `RAG_ENABLED` | `true` | 开关 |
| `RAG_EMBEDDING_BASE_URL` | `LLM_BASE_URL` | Embedding API 地址 |
| `RAG_EMBEDDING_API_KEY` | `LLM_API_KEY` | Embedding API 密钥 |
| `RAG_EMBEDDING_MODEL` | `text-embedding-3-small` | 嵌入模型名 |
| `RAG_CHROMA_URL` | `""` | ChromaDB 地址（空=用 MemoryVectorStore）|
| `RAG_PDF_DIR` | `""` | PDF 语料目录 |

## Agent 实现细节

### BaseAgent（抽象基类）

```typescript
abstract class BaseAgent {
  abstract readonly name: string
  protected abstract execute(state: TravelPlanState): Promise<TravelPlanState>

  run(state)          // 模板方法：try/catch 包裹 execute，失败写入 errorMessages
  callLlm(prompt)     // LLM 调用入口，provider=mock 返回模拟 JSON
  anthropicLlm()      // POST /v1/messages, x-api-key, non-streaming
  openaiLlm()         // POST /chat/completions, Bearer token
}
```

**设计决策**: `run()` 是 public 模板方法，`execute()` 是 protected 子类实现。异常不向上抛出，而是降级到 `state.errorMessages`，保证 pipeline 不中断。

### PreferenceAgent

- **输入**: `state.preferences`（必须非空）
- **处理**: 如果 `interests` 为空，根据 `travelStyle` 填充默认值：
  - budget → 景点、街边美食、公共交通
  - comfort → 美食、景点、购物
  - luxury → 米其林餐厅、SPA、私人导览
  - adventure → 户外运动、徒步、极限体验
  - cultural → 博物馆、历史古迹、文化体验
  - relaxation → 海滩、温泉、休闲度假
- **输出**: state → `RECOMMENDING_DESTINATIONS`

### DestinationAgent

**双模式选择逻辑**:

```
preferredDestination 存在?
  ├── YES → resolveByLlm(city, budget)
  │         构建 prompt 要求 JSON 格式返回
  │         callLlm() → 正则提取 JSON → 解析为 Destination
  │         失败则返回兜底对象（city + 空字段）
  └── NO  → pickFromMock(budget, style, startDate)
            对 6 个预设目的地评分排序取最优
```

**评分公式** (`scoreDestination`):

| 因子 | 权重 | 条件 |
|------|------|------|
| 预算匹配 | +30 / +15 | budget ≥ estCost / budget ≥ 70% estCost |
| 安全评分 | ×3 | safetyScore × 3 |
| 季节匹配 | +20 | 出发月份对应季节在 bestSeason 中 |
| 风格匹配 | +15 | styleCostPref[style] === costLevel |
| 免签加分 | +10 | visaRequired === false |

预设目的地：东京、曼谷、巴黎、清迈、首尔、大阪。

### FlightAgent

**Mock 生成** (`generateMockFlights`):
- 从 6 家中国航司随机选择：国航、东航、南航、海航、春秋、吉祥
- 价格范围：800 - 5000 元
- 飞行时长：2 - 12 小时
- 中转次数：0 - 2 次
- 生成去程和返程各 5 个候选

**最优航班评分** (`bestFlight`):

```
score = priceScore × 50 + durationScore × 30 + stopsScore × 20
        + (price ≤ budgetShare ? 10 : 0)
```

其中 priceScore、durationScore、stopsScore 都是归一化到 0-1 的值（越低越好）。

总成本 = (去程价 + 返程价) × 人数。

### HotelAgent

**Mock 生成** (`generateHotels`):
- 6 个模板酒店（青年旅舍到五星度假），根据 travelStyle 乘以价格系数：
  - budget ×0.6, comfort ×1.0, luxury ×2.0, adventure ×0.8, cultural ×0.9, relaxation ×1.2
- 随机噪声 ±30%

**最优酒店评分** (`bestHotel`):

```
score = (price ≤ nightlyBudget ? 20 : 0)
      + starMatch × 30
      + userRating × 3
      + distanceScore
```

**房间计算**: `rooms = Math.ceil(numTravelers / 2)`
**总成本**: pricePerNight × nights × rooms

### ActivityAgent

**每日规划** (`planOneDay`):
- 12 个默认活动池（sightseeing/food/experience 三类，morning/afternoon/evening 三时段）
- 为每天的 morning、afternoon、evening 各选一个活动
- 评分公式：`rating + (兴趣匹配 ? 3 : 0) + Math.random() × 2`
- 每日活动固定 3 个（早/午/晚各一），总成本 = 所有活动价格 × 人数

### BudgetAgent

**核心决策逻辑**:

```
total = flightCost + hotelCost + activityCost
remaining = budget - total

if remaining >= 0:
    → COMPLETED
elif adjustmentRound < maxAdjustments:
    → ADJUSTING, round++
    → applyAdjustments(state)
else:
    → COMPLETED + warnings
```

**逐轮削减策略** (`applyAdjustments`):

| 轮次 | 活动削减上限 | 酒店削减上限 | 航班削减上限 |
|------|-------------|-------------|-------------|
| 1 | 40% | - | - |
| 2 | 30% | 35% | - |
| 3+ | 20% | 25% | 25% |

削减方式：对 state 中已有的推荐结果按比例降价。

## 编排层细节

### ParallelExecutor

```typescript
class ParallelExecutor {
  constructor(agents[], log, timeout = 30s)

  async run(state): Promise<TravelPlanState> {
    const promises = agents.map(agent =>
      Promise.race([
        agent.run(state),
        timeoutReject(this.timeout)
      ])
    )
    const results = await Promise.allSettled(promises)
    // 失败的 agent 错误写入 state.errorMessages，不阻塞其他
  }
}
```

**关键特性**: `Promise.allSettled` 保证部分失败不阻塞全局；单个 agent 超时 30s 自动 reject。

### BudgetLoopController

```typescript
class BudgetLoopController {
  constructor(parallel, budgetAgent, log, maxRetries = 3)

  async run(state) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt === 0 || state.state === ADJUSTING) {
        await parallel.run(state)   // 并行搜索航班/酒店/活动
      }
      state = await budgetAgent.run(state)  // 预算检查
      if (state.state === COMPLETED || state.state === FAILED) return state
    }
    state.state = COMPLETED  // 强制完成
  }
}
```

**循环策略**: 首轮搜索 → 预算检查 → 超预算则标记 ADJUSTING → 次轮带削减参数重新搜索 → 最多 3 轮。

## API 层实现

### SSE 流式聊天（核心交互）

**`llm-client.ts`** — 底层 Anthropic API 客户端:

```typescript
streamChat(messages, tools?, system?, onDelta?) → Promise<ChatResult>

// SSE 解析流程：
// 1. fetch POST /v1/messages (stream: true)
// 2. 逐行解析 "data: {json}" SSE 帧
// 3. content_block_start → 初始化 contentBlocks[idx]
// 4. content_block_delta:
//    - text_delta → 拼接到 text block, 调用 onDelta(text)
//    - input_json_delta → 拼接到 toolInputBuffers[idx]
// 5. content_block_stop → JSON.parse(buffer) → 填入 tool_use block.input
// 6. message_stop → 结束
```

**`tools.ts`** — tool_use 定义与执行:

```typescript
const TOOLS = [{
  name: "plan_travel",
  input_schema: {
    required: ["destination", "departure_city", "start_date", "end_date", "budget"],
    properties: { destination, departure_city, start_date, end_date,
                  budget, travel_style, num_travelers, interests }
  }
}]

executeTool(name, input):
  plan_travel → 构建 UserPreferences → Pipeline.run() → 返回 PlanSummary
```

**`stream-handler.ts`** — SSE 聊天主逻辑:

```typescript
handleChatStream(req, reply):
  1. 设置 SSE 响应头 (text/event-stream, no-cache)
  2. runAgentLoop(messages, reply)

runAgentLoop(messages, reply):
  for round 0..4:
    result = streamChat(messages, TOOLS, SYSTEM_PROMPT, onDelta)
    // onDelta → writeSSE(reply, "text_delta", {text})

    if 无 tool_use events → break
    for each tool_use event:
      writeSSE("tool_start", {tool, input})
      result = executeTool(name, input)
      writeSSE("tool_result", {tool, result})
      追加 tool_result 到 messages → 继续循环
```

**SSE 事件类型**:

| 事件 | 方向 | 数据 |
|------|------|------|
| `text_delta` | Server → Client | `{ text: "..." }` |
| `tool_start` | Server → Client | `{ tool: "plan_travel", input: {...} }` |
| `tool_result` | Server → Client | `{ tool: "plan_travel", result: PlanSummary }` |
| `error` | Server → Client | `{ error: "message" }` |
| `done` | Server → Client | `{}` |

### 前端 (`chat.html`)

- **Tailwind CSS** CDN 布局，**marked.js** CDN 渲染 Markdown
- 用 `fetch` + `ReadableStream` 读取 SSE 流
- 解析 `event:` + `data:` 行，实时渲染打字效果
- `tool_result` 中的 `plan_travel` 结果渲染为行程卡片：
  - 目的地 + 天数
  - 三栏费用（机票/酒店/活动）
  - 预算进度条（绿色=预算内，红色=超支）
  - 推荐酒店、景点亮点、调整轮次

## 类型系统

所有类型通过 **Zod Schema** 定义在 `types/index.ts`，同时推导 TypeScript 类型：

```
UserPreferencesSchema  → UserPreferences    // 用户输入
DestinationSchema      → Destination        // 目的地信息
FlightSchema           → Flight             // 航班
HotelSchema            → Hotel              // 酒店
ActivitySchema         → Activity           // 活动
DayPlanSchema          → DayPlan            // 每日计划
BudgetBreakdownSchema  → BudgetBreakdown    // 预算明细
PlanRequestSchema      → PlanRequest        // API 请求体
```

**状态机** (`PlanningState` enum):

```
COLLECTING_PREFERENCES → RECOMMENDING_DESTINATIONS → SEARCHING_PARALLEL
  ↑                          │                           │
  │                          ▼                           ▼
  │               BudgetLoopController ──────► BUDGET_CHECKING
  │                                                 │
  │                                      ┌──────────┤
  │                                      ▼          ▼
  │                                   ADJUSTING   COMPLETED
  │                                      │
  └──────────────────────────────────────┘
                                      (最多 3 轮)
```

## 配置

通过 `.env` 环境变量配置，`settings.ts` 加载并冻结：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LLM_PROVIDER` | `mock` | `mock` / `anthropic` / `openai` |
| `LLM_API_KEY` | - | API 密钥 |
| `LLM_BASE_URL` | `https://api.minimax.chat/v1` | API 地址 |
| `LLM_MODEL` | `MiniMax-M2.7` | 模型名 |
| `LLM_TEMPERATURE` | `0.7` | 生成温度 |
| `LLM_MAX_TOKENS` | `4096` | 最大 token 数 |
| `BUDGET_MAX_RETRIES` | `3` | 预算调整最大轮次 |
| `PARALLEL_TIMEOUT` | `30` | 并行 agent 超时（秒） |
| `API_HOST` | `0.0.0.0` | 监听地址 |
| `API_PORT` | `3000` | 监听端口 |
| `LOG_LEVEL` | `info` | 日志级别 |
