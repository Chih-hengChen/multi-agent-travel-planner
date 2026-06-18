# Agent Loop Redesign (v2)

> v1 立项:2026-06-16
> v2 修订:2026-06-16,接受 review
> P0-A 落地:2026-06-18 (`feat/p0-a-agent-loop` 分支,9步全部完成)
> 状态:P0-A 已完成,待开 P0-B/P0-C
> 决策日志:
> - Q1=A(代码控制 Loop) / Q2=单 Loop / Q3=两级模型 / Q4=B+C / Q5=先扩 eval set
> - ReAct 落地 = `<thought>` 标签(方案 A)
> - 餐厅 = 两阶段(searching 城市级 + planning 景点级,排除连锁除非显式,本地特色 ≤60%)
> - XHS = xhs-service 主源,默认 limit=30,不够再爬 30

---

## 0. v2 变更摘要(相对 v1)

**新增**:
- §3.1 AgentState 补 5 字段(`candidateTransports` / `toolErrors` / `rerankScores` / `lastThought` / `budgetRound`)
- §3.2 餐厅两阶段搜索策略
- §3.2 `search_hotels` 加 `geoConstraint` 输入(景点周边距离约束)
- §3.2 `search_xhs` 实现方案(xhs-service + 渐进抓取)
- §3.3 `<thought>` 标签强制 + 解析(ReAct 真正落地)
- §3.3 State 全程 immutable + loop 末尾 `ctx.agentState = state`
- §3.3 JSON 自修复 `maxRetries=3`
- §3.6 高德 API QPS 限流(≤3/s)
- §4.4 数据飞轮最后一公里(`optimization-log.md` + `prompts/versions/`)
- §4.6 Timeline viewer 三栏 HTML 结构
- §4.7 工具降级链表(policy 表格化 + trace 记 `fallback_level`)
- §10 关联文档

**修订**:
- §4.1 表格补 thought 标签归 LLM
- §4.3 `baseRelevance` 来源说明 + 餐厅多样性公式
- §6 风险增加 §6.6 prompt 漂移 / §6.7 QPS 超限

---

## 1. 设计目标

把"流程编排式"重构为"Agentic 式"(代码控制主循环 + LLM 单步决策)。

**核心特征(类 claude-code)**:
- Loop 主体在 TS,LLM 每轮返回单步决策(tool_use 或最终答)
- 工具调用前后都过代码逻辑:phase gating / schema 校验 / 重复检测 / 超时控制 / 降级链
- 单 Agent Loop,phase 字段驱动工具可用集与模型选择
- **ReAct 显式化**:LLM 每轮强制输出 `<thought>...</thought>` 块,代码解析后写 trace,让"为什么调这个工具"可观测、可复盘
- LLM 无状态,代码维护 state,history 全量传入(上下文管理暂缓,§7)

---

## 2. 整体架构

### 2.1 数据流

```
HTTP /api/chat/:sid (SSE)
     │
     ▼
ConversationOrchestrator.handleMessage
     │  load ConversationContext (含 AgentState + messageHistory)
     ▼
┌─────────────────────────────────────────────────────────────┐
│  Agent Loop  (src/runtime/agent-loop.ts)                     │
│                                                               │
│  messages.push({role:"user", content:userMessage})           │
│  for iter in 0..MAX_ITER:                                     │
│    1. pickModel(state.phase) + pickTools(state.phase)        │
│    2. resp = LLM.call(messages, tools, systemPrompt)         │
│    3. thought = parseThought(resp.text)   ← ReAct 关键       │
│    4. trace("llm_response", {iter, thought, toolCalls, ...}) │
│    5. messages.push({role:"assistant", content:resp.content})│
│    6. if no tool_use:                                        │
│         if canFinish(state, resp): → finalize                │
│         else push forceContinue                              │
│    7. validation = validateToolCalls(resp.toolCalls, state)  │
│       rejected → push rejection                              │
│    8. results = executeToolsParallel(approved, state)        │
│       每个 result 携带 fallback_level(0=主源,1=降级,2=兜底)│
│    9. messages.push(tool_results)                            │
│   10. state = applyToolEffects(state, results)  ← immutable │
│   11. state = maybeAdvancePhase(state)                       │
│   12. emit SSE: progress / options / partial                 │
│   13. if state.phase === "completed": → finalize             │
│                                                               │
│  ctx.agentState = state  ← 末尾 sync(immutable 模式)        │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 与当前架构的差异

| 维度 | 当前 | Redesign v2 |
|------|------|-------------|
| 主驱动 | TurnHandler 硬编码分支 + Pipeline 直线 | 单 Agent Loop |
| 状态机 | 双状态机(对话 11 + Pipeline 7,共 18) | 单 state object,phase 字段驱动 |
| 工具系统 | LLMPlanAgent 内联 5 + ToolRegistry 8(死代码) | 统一 ToolRegistry,12+ 工具按 phase 暴露 |
| 模型选择 | 各 Agent 硬编码 | `pickModel(phase, task)` 表驱动 |
| LLM 角色 | 不同 Agent 不同 prompt | 统一 system prompt + phase 提示 |
| 并行检索 | PipelineExecutor.allSettled | LLM parallel_tool_use 一次调多源 |
| ReAct | 无 | `<thought>` 标签强制 + trace 可视化 |
| 可观测性 | sessionLogger.jsonl 事件流 | 结构化 trace + timeline UI + fallback_level |

---

## 3. 核心组件

### 3.1 AgentState

```ts
interface AgentState {
  phase: "gathering" | "searching" | "selecting" | "planning" | "completed";
  iteration: number;
  budgetRound: number;  // 预算循环计数,increment 时机见 p0-a-contracts §1.4

  // 用户偏好(gathering 阶段填充)
  preferences?: UserPreferences;

  // 检索结果(searching 阶段填充)
  baikeKnowledge?: string;
  weather?: WeatherSummary;
  candidateAttractions?: Activity[];
  candidateHotels?: Hotel[];
  candidateRestaurants?: Activity[];       // 城市级餐厅(searching 阶段)
  candidateTransports?: TransportOption[]; // 交通候选(去程+返程)
  xhsNotes?: XhsNote[];                    // 默认 30 篇,不够再爬

  // 用户选择(selecting 阶段填充)
  selectedOutbound?: TransportOption;
  selectedReturn?: TransportOption;
  selectedHotel?: Hotel;

  // 行程(planning 阶段填充)
  dayPlans?: DayPlan[];
  budgetBreakdown?: BudgetBreakdown;
  planningRestaurants?: Activity[];  // planning 阶段景点周边搜的餐厅

  // 元数据
  priceWarnings: string[];
  errorMessages: string[];
  toolErrors: Record<string, string>;       // 工具级错误(用于 debug)
  rerankScores: Record<string, number>;     // 项 → 评分(trace 里看为什么选这个)
  lastThought?: string;                     // 最近一次 ReAct thought(给 canFinish 用)
  fallbackUsage: Record<string, number>;    // tool → 累计降级次数
}
```

**Phase 转换条件**(纯代码判定,不靠 LLM):

| from → to | 条件 |
|-----------|------|
| gathering → searching | preferences 必填字段齐全(destination/departureCity/startDate/endDate/numTravelers/budget) |
| searching → selecting | `candidateTransports.length > 0 && candidateHotels.length > 0` |
| selecting → planning | `selectedOutbound && selectedReturn && selectedHotel` |
| planning → completed | `dayPlans.length === travelDays && budgetBreakdown.isWithinBudget` 或 `budgetRound >= MAX_BUDGET_ROUNDS` |

### 3.2 工具注册表

**目录结构**:

```
src/tools/
├── registry.ts                # ToolRegistry
├── types.ts
├── schemas/                   # 共享 Zod schema(消除漂移)
├── definitions/
│   ├── collect-preferences.ts
│   ├── search-baike.ts        # 新
│   ├── search-attractions.ts
│   ├── search-restaurants.ts  # 两阶段语义(见 §3.2.1)
│   ├── search-hotels.ts       # 加 geoConstraint(见 §3.2.2)
│   ├── search-xhs.ts          # xhs-service 渐进抓取(见 §3.2.3)
│   ├── search-weather.ts
│   ├── search-travel-guides.ts
│   ├── plan-transit.ts        # 新:市内交通规划
│   ├── select-transport.ts
│   ├── select-hotel.ts
│   └── finalize-plan.ts       # 输出结构化 JSON
└── policy.ts                  # phase gating + 降级链表 + QPS 限流
```

**工具 phase 矩阵**(v2 修订:search_restaurants 跨两阶段):

| 工具 \ Phase | gathering | searching | selecting | planning |
|--------------|-----------|-----------|-----------|----------|
| collect_preferences | ✅ | ❌ | ❌ | ❌ |
| search_baike | ❌ | ✅ | ❌ | (已缓存) |
| search_weather | ❌ | ✅ | ❌ | (已缓存) |
| search_attractions | ❌ | ✅ | ❌ | ✅(补搜) |
| **search_restaurants** | ❌ | **✅(城市级)** | ❌ | **✅(景点级)** |
| search_hotels | ❌ | ✅ | ❌ | ❌ |
| search_xhs | ❌ | ✅ | ❌ | ✅ |
| search_travel_guides | ❌ | ✅ | ❌ | ✅ |
| plan_transit | ❌ | ❌ | ❌ | ✅ |
| select_transport | ❌ | ❌ | ✅ | ❌ |
| select_hotel | ❌ | ❌ | ✅ | ❌ |
| finalize_plan | ❌ | ❌ | ❌ | ✅ |

#### 3.2.1 餐厅两阶段搜索策略

**searching 阶段(城市级)**:
- LLM 调用 `search_restaurants({ city, scope: "city" })`
- 实现:走 `xhs-service` 搜"城市 + 美食" + 高德 POI 城市热门
- 结果存 `state.candidateRestaurants`,供 LLM 后续 prompt 引用
- 目的:让 LLM 编排行程前已有"城市餐饮画像"

**planning 阶段(景点级)**:
- LLM 调用 `search_restaurants({ city, scope: "attraction", near: "故宫", mealType: "lunch" })`
- 实现:高德 POI 周边搜索(`location` 参数 = 景点经纬度,`radius` = 1500m)
- 结果存 `state.planningRestaurants`,供当日行程编排
- 目的:景点→景点之间的衔接餐饮(用户原话:"景点与景点之间衔接")

**过滤规则**(在工具实现层):
```ts
function filterRestaurants(list: Activity[], prefs: UserPreferences): Activity[] {
  return list.filter(r => {
    // 1. 排除连锁(除非用户显式要求)
    const isChain = CHAIN_BRANDS.has(r.name);
    if (isChain && !prefs.preferredHotelBrands?.length) return false;

    // 2. 控制本地特色比例 ≤ 60%(在 rerank 阶段做,见 §4.3)

    // 3. 排除黑名单(用户历史 negative feedback)
    if (prefs.dislikedFoods?.some(f => r.name.includes(f))) return false;

    return true;
  });
}
```

**信息源融合**(高德 + XHS + RAG):
- 高德 POI:权威价格/位置/营业时间 → baseRelevance × 0.85
- XHS 笔记:真实评价/口味描述/避坑提示 → baseRelevance × 0.70
- RAG 攻略:深度推荐/搭配建议 → baseRelevance × 0.65
- 三源融合时按 `name` 字段做归并,分数加权

#### 3.2.2 search_hotels geoConstraint

```ts
// search_hotels 输入
{
  city: string;
  checkIn: string;       // YYYY-MM-DD
  checkOut: string;
  adults: number;

  // 新增:地理位置合理性
  preferredArea?: string;              // 用户指定("故宫附近"、"朝阳区")
  keyAttractions?: string[];           // planning 已选景点名称
  geoConstraint?: {
    maxDistanceKm: number;             // 离 keyAttractions 几何中心的距离上限
    preferNear?: "transit" | "center"; // 地铁站附近 / 市中心
  };

  maxPricePerNight?: number;
  preferredBrands?: string[];
}
```

**实现层**:高德 POI 酒店 + Haversine 距离过滤 + Booking 价格交叉验证。当前 `BookingSource` 已有 `distanceToCenterKm`,但缺"距核心景点"维度,P0-B 时补。

#### 3.2.3 search_xhs 实现方案

```ts
// 默认参数
{
  query: string;
  limit?: number;       // 默认 30
  extractMore?: number; // 不够时再爬多少,默认 30
}

// 调用链
async execute(input) {
  // 1. 主源:自建 xhs-service(127.0.0.1:3220,curl_cffi 反爬)
  let notes = await xhsService.search(input.query, input.limit ?? 30);

  // 2. 不够(少于 limit/2)→ 渐进再爬
  if (notes.length < (input.limit ?? 30) / 2) {
    const more = await xhsService.search(
      expandQuery(input.query),  // 同义词扩展
      input.extractMore ?? 30
    );
    notes = dedupe([...notes, ...more]);
  }

  // 3. 提炼:rerank 后只给 LLM top-K(K=10),全量留存 state
  const ranked = rerankXhs(notes, state.preferences);
  state.xhsNotes = notes;          // 全量留存(供后续 planning 引用)
  return { top: ranked.slice(0, 10), total: notes.length };
}
```

**降级链**(xhs-service 不可用时):
1. xhs-service:3220 主源(curl_cffi 反爬)
2. WebSearch `site:xiaohongshu.com`(搜索引擎降级)
3. RAG `travel_guides` 中 source=xhs 的笔记(最后兜底)

trace 记录用了第几级(`fallback_level: 0/1/2`)。

### 3.3 Agent Loop 主循环(伪代码)

```ts
async function runAgentLoop(
  ctx: ConversationContext,
  userMessage: string,
  emit: SSEEmitter,
): Promise<ConversationContext> {
  let state: AgentState = { ...ctx.agentState };  // 全程 immutable,从快照开始
  const messages = [...ctx.messages];
  messages.push({ role: "user", content: userMessage });

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    state.iteration = iter;

    const registry = buildRegistryForPhase(state.phase);
    const model = pickModel(state.phase);

    trace("llm_request", { iter, phase: state.phase, model, tools: registry.list() });

    const resp = await callLLM({
      model,
      messages,
      tools: registry.getToolDefs(),
      systemPrompt: buildSystemPrompt(state),  // 含 thought 强制指令
      temperature: pickTemperature(state.phase),
      maxTokens: pickMaxTokens(state.phase),
    });

    // ReAct 关键:解析 <thought>...</thought>
    const thought = parseThought(resp.text);
    state.lastThought = thought;
    trace("llm_response", {
      iter,
      stopReason: resp.stopReason,
      thought,                                       // 显式 reasoning
      toolCalls: resp.toolCalls.map(tc => tc.name),
      fallbackUsage: state.fallbackUsage,
    });

    messages.push({ role: "assistant", content: resp.content });

    if (resp.toolCalls.length === 0) {
      if (canFinish(state, resp)) {
        ctx.agentState = state;  // 末尾 sync
        return finalize(ctx, resp, emit);
      }
      messages.push({ role: "user", content: forceContinuePrompt(state) });
      continue;
    }

    const validation = validateToolCalls(resp.toolCalls, state, registry);
    if (validation.rejected.length > 0) {
      messages.push({ role: "user", content: rejectionPrompt(validation.rejected, state.phase) });
      continue;
    }

    const results = await executeToolsParallel(validation.approved, state, emit);

    // 工具结果回传(每个 result 带 fallback_level)
    messages.push({
      role: "user",
      content: results.map(r => ({
        type: "tool_result",
        tool_use_id: r.toolUseId,
        content: JSON.stringify({ ...r.data, _fallback_level: r.fallbackLevel }),
      })),
    });

    // immutable:每次返回新对象
    state = applyToolEffects(state, results);
    state = maybeAdvancePhase(state);

    if (state.phase === "completed") {
      ctx.agentState = state;
      return finalize(ctx, null, emit);
    }
  }

  ctx.agentState = state;  // 即使超时也保存当前进度,下次续行
  throw new AgentLoopOverflowError(state);
}

function parseThought(text: string | undefined): string {
  if (!text) return "";
  const m = text.match(/<thought>([\s\S]*?)<\/thought>/);
  return m ? m[1].trim() : "";
}
```

**system prompt 强制 thought**(P0-A 时写到 `prompts/system.md`):
```text
在每次决策前,你必须先输出 <thought>...</thought> 块,描述:
1. 当前 phase 与已有信息(1 句)
2. 下一步要做什么、为什么(1-2 句)
3. 拟调用的工具与关键参数

示例:
<thought>
phase=searching, 已有目的地东京 + 偏好Comfort。下一步需要并行获取
景点/酒店/小红书真实评价。调用 search_attractions/xhs/hotels。
</thought>
```

**JSON 自修复 maxRetries**(§4.2):
```ts
let repairAttempts = 0;
let parsed: Plan;
while (repairAttempts < 3) {
  try {
    parsed = parsePlanLoose(raw);  // 三层防御
    break;
  } catch (err) {
    repairAttempts++;
    messages.push({
      role: "user",
      content: `JSON 解析失败(${err.message})。上次输出末尾:\n${raw.slice(-300)}\n请重新输出完整 JSON。`,
    });
    // 重新调 LLM... (Loop 内套小循环)
  }
}
if (repairAttempts >= 3) throw new JsonRepairExhaustedError(raw);
```

### 3.4 模型分层(两级)

```ts
function pickModel(phase: Phase): string {
  switch (phase) {
    case "gathering": return settings.LLM_LIGHT_MODEL;  // 抽取 + 提问
    case "searching": return settings.LLM_LIGHT_MODEL;  // 工具选择
    case "selecting": return settings.LLM_LIGHT_MODEL;  // 选项解释
    case "planning":  return settings.LLM_MODEL;        // 行程编排(重)
    case "completed": return settings.LLM_LIGHT_MODEL;  // 收尾
  }
}
```

默认小模型,只 planning 用大模型。速度/成本最优。

### 3.5 并行工具调用

Anthropic API 原生支持单次 response 返回多 tool_use 块。Loop 直接 `Promise.allSettled`:

```ts
async function executeToolsParallel(
  calls: ToolCall[],
  state: AgentState,
  emit: SSEEmitter,
): Promise<ToolResult[]> {
  const settled = await Promise.allSettled(
    calls.map(c => registry.execute(c.name, c.input, { state, emit }))
  );
  return settled.map((s, i) =>
    s.status === "fulfilled" ? s.value : toolError(calls[i], s.reason)
  );
}
```

system prompt 加 hint:
```text
当需要检索多个独立信息源(景点/酒店/小红书/百科),请一次性并行调用所有相关工具。
```

### 3.6 高德 API QPS 限流 ⚠️

**约束**:高德 Web API 单 key 限 QPS ≤ 3(用户明确要求)。当前 `AmapSource` 已有限流,P0-B 时把限流提到工具层:

```ts
// src/tools/policy.ts
const amapLimiter = new TokenBucket({ capacity: 3, refillPerSec: 3 });

async function callAmap<T>(fn: () => Promise<T>): Promise<T> {
  await amapLimiter.acquire();
  return fn();
}

// search_attractions / search_restaurants / search_hotels / plan_transit
// 凡涉及高德,统一过 amapLimiter
```

trace 记录 `amap_wait_ms` 字段,方便复盘限流影响。

planning 阶段一天搜多次餐厅时,工具实现层做**结果缓存**(`景点+mealType → 餐厅列表`,TTL 5min),避免重复打高德。

---

## 4. 关键设计决策

### 4.1 代码控制 vs LLM 自主的边界

| 决策点 | 代码控制 | LLM 自主 |
|--------|---------|---------|
| Phase 转换 | ✅ 硬条件 | ❌ |
| 工具可用集(phase gating) | ✅ | ❌ |
| 工具调用合法性(schema + 状态) | ✅ | ❌ |
| **ReAct thought 表达** | ❌(只解析) | ✅(强制输出) |
| 工具调用选择 | ❌ | ✅ |
| 检索 query 构造 | ❌ | ✅ |
| 行程编排顺序 | ❌ | ✅ |
| JSON 结构 | ❌ | ✅(代码 repair) |

**原则**:**安全/正确性 → 代码;创造性/reasoning → LLM**。

### 4.2 JSON 鲁棒(三层 + maxRetries)

```ts
// 第 1 道:正则提取最外层 {...}
const match = raw.match(/\{[\s\S]*\}/);

// 第 2 道:JSON.parse + Zod
try { return schema.parse(JSON.parse(match[0])); }

// 第 3 道:jsonrepair(尾逗号 / 缺括号 / 单引号)
import { jsonrepair } from "jsonrepair";
const repaired = jsonrepair(match[0]);
return schema.parse(JSON.parse(repaired));
```

**LLM 自修复**:三层都失败时,把错误 + 原文 excerpt 回传 LLM,**最多重试 3 次**(`repairAttempts < 3`),仍失败抛 `JsonRepairExhaustedError`,trace 记录最后一次原文供复盘。

依赖:`npm i jsonrepair`(单文件,~5KB,无传递依赖)。

### 4.3 信息源 rerank

**baseRelevance 来源**(v2 补):

| 信息源 | baseRelevance 来源 | 默认值 |
|--------|-------------------|--------|
| RAG 检索 | 向量余弦相似度 | 0~1 |
| 高德 POI | `rating / 10`(评分归一化) | 0~1 |
| 酒店(Booking) | `userRating / 10` | 0~1 |
| XHS 笔记 | `log(liked_count + 1) / log(MAX_LIKES + 1)` | 0~1 |
| 百科 | 固定 0.95(权威) | 0.95 |
| LLM 兜底 | 固定 0.30 | 0.30 |

**聚合公式**:
```
finalScore = baseRelevance * SOURCE_WEIGHT[source]
           + interestMatch * 0.25      // 兴趣关键词
           + specificityBoost * 0.10   // 名称/类别具体度
           - redundancyPenalty          // 已选/已添加降权
```

**SOURCE_WEIGHT**:
```ts
const SOURCE_WEIGHTS = {
  baike: 0.95,
  official_poi: 0.85,    // 高德
  hotel_provider: 0.80,  // Booking
  xhs: 0.70,
  web_search: 0.45,
  llm_generated: 0.30,
};
```

**餐厅多样性约束**(用户明确要求):
```ts
function rerankRestaurants(list: Activity[], prefs: UserPreferences): Activity[] {
  const localCap = Math.ceil(list.length * 0.6);  // 本地特色 ≤ 60%
  let countLocalSoFar = 0;

  return list
    .map(r => ({ ...r, score: scoreRestaurant(r, prefs) }))
    .sort((a, b) => b.score - a.score)
    .filter(r => {
      if (isLocalSpecialty(r, prefs.destination)) {
        return countLocalSoFar++ < localCap;
      }
      return true;
    });
}
```

> 例:北京豆汁是本地特色但风评差。如果列表里本地特色已占 60%,豆汁被剔除;否则保留但分数低,LLM 可在描述中提示"评价两极,可尝鲜"。

### 4.4 数据飞轮

**存储**:
```
data/feedback/
├── sessions/{sid}.json          # 完整 trace + 用户评分 + LLM 自评
├── llm-self-eval.jsonl          # LLM 自评流水
└── patterns-{YYYY-MM}.md        # 月度失败模式聚类(脚本生成)

docs/
├── optimization-log.md          # 每次 prompt / 参数变更决策记录
├── rag-optimization-log.md      # RAG 实验记录(关联 RAG plan)
└── prompt-versions/
    ├── README.md                # 版本管理说明
    ├── system-v1.md             # 当前 system prompt 快照
    └── system-v2.md             # 修订后(P0-A 时填)

prompts/
├── system.md                    # 当前生效(从 versions/ 选)
├── chat-system.ts               # TS 实现(不变)
└── versions/                    # 软链接或 import
```

**收集路径**:
1. 每次 finalize 后,自动 POST `/api/feedback`,存 trace + 上下文摘要
2. chat.html 加 1-5 星按钮 → POST `/api/feedback/:sid/rate`
3. finalize 后另一次 LLM 调用(`plan-self-eval-prompt`),打分 1-5 + 失败原因分类

**最后一公里(v2 补)**:patterns.md → prompt 版本管理 → A/B 比较
```
patterns-2026-06.md
  ├─ Pattern: 餐厅推荐单一 → 占 35% 低分 case
  └─ Action: 修订 system prompt v2,加"每天至少 3 家不同餐厅"约束

system-v2.md
  - 基于 v1 + patterns 修订
  - 在 optimization-log.md 记录变更条目

A/B 比较:
  - v1 跑 50 case,自评均分 3.2
  - v2 跑 50 case,自评均分 ?
  - 若 +0.3 以上 → v2 转 main;否则回滚
```

### 4.5 可观测性 trace 格式(v2 补 thought + fallback_level)

```jsonl
{"ts":"2026-06-16T10:00:01Z","sid":"abc","iter":0,"type":"llm_request","phase":"gathering","model":"glm-4.7","tools":["collect_preferences"]}
{"ts":"...","iter":0,"type":"llm_response","stop_reason":"tool_use","thought":"用户说预算但没说目的地,先调 collect_preferences 触发弹窗","tool_calls":[{"name":"collect_preferences"}]}
{"ts":"...","iter":0,"type":"tool_exec","tool":"collect_preferences","duration_ms":1200,"fallback_level":0,"requires_user_input":true}
{"ts":"...","iter":0,"type":"state_change","op":"set","field":"preferences","value_summary":"{destination:东京,...}"}
{"ts":"...","iter":0,"type":"phase_change","from":"gathering","to":"searching","reason":"basics complete"}
{"ts":"...","iter":1,"type":"llm_response","thought":"phase=searching,已有东京+Comfort。并行调百科/景点/酒店/XHS","tool_calls":[{"name":"search_baike"},{"name":"search_attractions"},{"name":"search_hotels"},{"name":"search_xhs"}]}
{"ts":"...","iter":1,"type":"tool_exec","tool":"search_xhs","duration_ms":3400,"fallback_level":0,"result_count":30}
```

### 4.6 Timeline viewer HTML 结构(v2 具体化)

`scripts/trace-viewer.ts` 读 jsonl 生成单文件 HTML,三栏布局:

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Session: abc  |  Phase: planning  |  Total iters: 12  |  Score: ⭐⭐⭐⭐ │
├──────────┬───────────────────────────────────┬──────────────────────────┤
│ 左栏:     │ 中栏:当前轮详情                    │ 右栏:state diff          │
│ iter 列表 │                                   │                          │
│          │ ┌─ Thought ─────────────────┐    │ preferences: {...}       │
│ ▶ iter 0 │ │ phase=searching,已有...    │    │   + destination: "东京"   │
│   iter 1 │ │ 并行调 4 个搜索工具        │    │   + budget: 15000        │
│   iter 2 │ └────────────────────────────┘    │                          │
│   iter 3 │                                   │ candidateAttractions:    │
│   ...    │ Tool calls:                       │   + 浅草寺 (0.82)        │
│          │ • search_baike [325ms, L0]        │   + 明治神宫 (0.78)      │
│ Phase:   │ • search_attractions [1.2s, L0]   │   + ...                  │
│ gather 2 │ • search_hotels [800ms, L0]       │                          │
│ search 4 │ • search_xhs [3.4s, L0, 30 notes] │ selectedHotel:           │
│ select 2 │                                   │   ✓ Hotel Mystays (0.85)│
│ plan   4 │ Result sample:                    │                          │
│          │   { "attractions": [...],         │ rerankScores:            │
│          │     "fallback_level": 0 }         │   "浅草寺": 0.82          │
│          │                                   │   "明治神宫": 0.78       │
│          │                                   │                          │
│          │                                   │ toolErrors:              │
│          │                                   │   (empty)                │
└──────────┴───────────────────────────────────┴──────────────────────────┘
```

- 左栏:点击 iter 跳转中栏
- 中栏:thought + tool_calls(含耗时/fallback_level)+ 结果摘要(前 200 字)
- 右栏:state diff(本轮新增/修改字段)
- 顶部:session 元数据 + 用户评分

### 4.7 工具降级链表(v2 新增)

`src/tools/policy.ts`:

```ts
const TOOL_FALLBACK_CHAIN: Record<string, string[]> = {
  search_baike:         ["baike_api", "web_search_baidu", "llm_generated"],
  search_attractions:   ["amap_poi", "web_search", "llm_generated"],
  search_restaurants:   ["amap_poi", "xhs_service", "web_search", "rag_travel_guides"],
  search_hotels:        ["booking_api", "amap_poi", "web_search"],
  search_xhs:           ["xhs_service", "web_search_site_filter", "rag_travel_guides"],
  search_weather:       ["amap_weather", "web_search"],
  search_travel_guides: ["rag_vector", "rag_keyword_fallback"],
  plan_transit:         ["amap_direction", "haversine_estimate"],
};

// trace 记录每次调用走了第几级
interface ToolResult {
  // ...
  fallbackLevel: number;  // 0=主源, 1=第一降级, 2=第二降级, ...
}
```

trace-viewer 显示 `fallback_level`,复盘时一眼看出"今天 30% 的 search_xhs 走了 web_search 降级"。

---

## 5. 实施路径

### P0 — 框架

**P0-A:Agent Loop 主框架** ✅ 2026-06-18 完成(9 commits)
- `src/runtime/agent-loop.ts` — 主循环 + ReAct thought 解析
- `src/runtime/state.ts` — AgentState + phase 转换 + canFinish
- `src/runtime/trace.ts` — 结构化 trace + jsonl 写入
- `src/runtime/apply-tool-effects.ts` — immutable state reducer + 13 handlers
- `src/runtime/validate-tool-calls.ts` — 4 类校验(phase/schema/dedup/precondition)
- `src/runtime/system-prompt.ts` — BASE + 5 phase prompts + state 摘要
- `src/tools/policy.ts` — phase gating + 降级链表 + QPS 限流(TokenBucket)
- `src/tools/definitions/plan-schema.ts` — Zod 行程 JSON schema + parsePlanLoose
- `src/tools/definitions/plan-transit.ts` — 市内交通(高德路径规划 + Haversine 降级)
- `src/tools/definitions/finalize-plan.ts` — 行程交付 + computeBudgetBreakdown
- `src/runtime/index.ts` — barrel export
- 单元测试 216 条覆盖(7 runtime 文件 + 2 tools 文件)

**P0-B:工具系统重做**(5-6 天,因加餐厅两阶段 + hotel geoConstraint)
- 迁 LLMPlanAgent 内联 5 工具到 `tools/definitions/`
- 删 `api/tools.ts`(死代码)
- 新增工具:search_baike / plan_transit / select_transport / select_hotel / finalize_plan
- 餐厅两阶段实现(scope 参数)
- search_hotels geoConstraint
- search_xhs 渐进抓取(默认 30,不够 +30)
- schema 抽到 `tools/schemas/`

**P0-C:Loop 接入对话流**(3-4 天)
- TurnHandler → 委托 Agent Loop
- 保留 ConversationOrchestrator(HTTP/SSE 桥)
- 删旧 Pipeline / BudgetLoopController

### P1 — 质量

**P1-A:JSON 鲁棒**(1 天)— `jsonrepair` + Zod + maxRetries=3

**P1-B:RAG 优化**(独立文档 `docs/rag-optimization-plan.md`,5-7 天)

**P1-C:行程质量**(4-5 天,因加景点间餐厅衔接 + 多样性)
- 每日时间线 + 市内交通(plan_transit)
- 餐厅两阶段 rerank(本地特色 ≤60%、排除连锁除非显式)
- 信息源融合(高德 + XHS + RAG)

### P2 — 闭环

**P2-A:可观测性**(4-5 天)— trace-viewer + 三栏 HTML

**P2-B:数据飞轮**(5-6 天,因加 prompt 版本管理 + A/B)
- `/api/feedback` 端点 + chat.html 评分 UI
- LLM 自评
- `review-feedback.ts` 复盘脚本
- `optimization-log.md` 流程
- `prompt-versions/` 版本管理

**P2-C:降级路径细化**(2-3 天)— `TOOL_FALLBACK_CHAIN` + trace `fallback_level`

### 最后 — 简历 md

`docs/resume-highlight.md`:基于已落地代码 + 真实指标。

---

## 6. 风险与权衡

### 6.1 LLM 调用次数与成本
Agent Loop 比直线 Pipeline 多 2-3 倍调用。对策:默认小模型,只 planning 用大;MAX_ITERATIONS=50。

### 6.2 Phase gating 太严 → LLM 卡死
连续 3 次同种 rejection → force_finish;maxIterations 兜底。

### 6.3 SSE 长连接
每 5s emit heartbeat;工具前后 emit progress;超时阈值放宽到 10min。

### 6.4 与现有 Pipeline 迁移共存
特性开关 `runtime/use-agent-loop.ts`;老路径 `/api/plan` 保留;新路径 `/api/chat/:sid` 逐步切。

### 6.5 RAG eval 样本偏差
LLM 合成按 5 类配额;上线后真实 query 持续替换;eval set 版本化。

### 6.6 Prompt 漂移(v2 新增)
system-v1 → v2 → v3 ...,每次修订可能引入回归。
**对策**:每次 prompt 变更必跑 50 case A/B;`optimization-log.md` 强制记录变更条目 + 指标对比;失败回滚。

### 6.7 高德 QPS 超限(v2 新增)
工具层 `amapLimiter`(capacity=3,refill=3/s),planning 阶段一天搜多餐时打满 → 排队等。
**对策**:结果缓存(`景点+mealType → 餐厅`,TTL 5min);trace 记 `amap_wait_ms`,>2s 触发告警。

### 6.8 XHS 反爬升级
xhs-service 用 curl_cffi 伪装 TLS 指纹,但 XHS 可能升级反爬。
**对策**:每周跑一次 `xhs-service` 健康检查脚本;失败时 fallback_level=1 自动启用,无需人工。

---

## 7. 不做 / 暂缓

- **上下文管理**(用户暂缓)— Loop 内不摘要/压缩,history 全量传。等真出现 token 超限再加
- **多 Agent 协作** — 单 Loop 单 Agent
- **微调** — prompt + 工程即可

---

## 8. 验收标准

**P0 完成后**:
1. ⚡ 代码层面:Agent Loop 驱动 + 5 phase 门控(preferences/transport+hotel/selection/dayPlans+budget)
2. ✅ searching 阶段 LLM 可并行调 ≥3 工具(baike / xhs / attractions / hotels 等)
3. ✅ 每轮 LLM 输出含 `<thought>` 块,`parseThought` 解析写入 `state.lastThought`,trace 可见
4. ⏳ selecting 需真实 LLM 接入后验证(当前 mock 验证了 select_transport + select_hotel 工具)
5. ✅ planning 调 finalize_plan,Zod 校验通过,parsePlanLoose 三层防御(maxRetries=3)
6. ✅ trace 写 jsonl(7 种事件类型),trace-viewer 三栏 HTML 待 P2-A
7. ✅ 全程 immutable state,loop 末尾 `ctx.agentState = state`

**P1 完成后**:
8. eval set ≥ 100 条,RAG Hit Rate 报告产出(见 RAG plan)
9. JSON 解析失败率 < 1%(基线对比)
10. 每日行程含市内交通(plan_transit ≥ 1/天)
11. 餐厅多样性:本地特色 ≤60%,无连锁(除非显式)
12. XHS 默认 30 篇,不够再爬 30,全量存 state
13. 高德 QPS ≤3/s,trace 有 `amap_wait_ms`

**P2 完成后**:
14. 评分按钮工作,数据落 `data/feedback/`
15. `patterns-{month}.md` 自动产出
16. `optimization-log.md` 记每次 prompt 变更
17. A/B 比较脚本存在(50 case × 2 版本)
18. `TOOL_FALLBACK_CHAIN` 完整,trace 有 `fallback_level`
19. 简历 md 引用真实指标

---

## 9. 下一步

P0-A 已于 2026-06-18 完成(`feat/p0-a-agent-loop` 分支,9步,216 测试通过)。

**建议下一步:P0-B(工具系统重做)**:
- 迁 LLMPlanAgent 内联 5 工具到 `tools/definitions/`
- 删 `api/tools.ts`(死代码)
- 新增工具:search_baike / select_transport / select_hotel
- 餐厅两阶段实现(scope 参数)
- search_hotels geoConstraint
- search_xhs 渐进抓取(默认 30,不够 +30)

**P0-C(对话流接入)**:
- TurnHandler → 委托 Agent Loop
- 保留 ConversationOrchestrator(HTTP/SSE 桥)
- 删旧 Pipeline / BudgetLoopController

---

## 10. 关联文档

| 文档 | 内容 |
|------|------|
| `docs/agent-loop-redesign.md`(本文档) | 总体设计 |
| `docs/rag-optimization-plan.md` | RAG 独立优化方案(baseline + 5 variants + 100 条 eval set) |
| `docs/optimization-log.md` | 每次 prompt / 参数 / 工具变更决策记录(模板) |
| `docs/rag-optimization-log.md` | RAG 实验记录(每个 variant 一节) |
| `docs/prompt-versions/README.md` | prompt 版本管理说明 |
| `docs/p0-a-contracts.md` | P0-A 接口契约(5 核心函数 + 2 工具 + JSON schema) |
| `docs/p0-b-contracts.md` | P0-B 接口契约(8 工具 + Schema 抽取 + LLMPlanAgent 迁移) |
| `src/ARCHITECTURE.md` | 当前架构(实施过程中持续更新) |
| `progress.md` | 高阶进度交接 |
