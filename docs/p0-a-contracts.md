# P0-A 接口契约

> 关联:`docs/agent-loop-redesign.md` §3.3 / §4 / §10
> 立项:2026-06-16(v2 review 后补)
> 状态:**Hard contract** — P0-A 实现期不允许偏离,变更需更新本文档 + 重跑测试
> 目的:把 redesign v2 §3.3 主循环里调用的 5 个未定义函数 + 2 个未完整设计的工具 + 行程 JSON schema 全部锁定,P0-A 第一个 commit 即可对照实现

---

## 0. 文档定位

redesign v2 §3.3 伪代码调用了这些函数:`pickModel / pickTools / callLLM / parseThought / canFinish / finalize / validateToolCalls / rejectionPrompt / executeToolsParallel / applyToolEffects / maybeAdvancePhase / buildSystemPrompt`。

其中:
- `pickModel / pickTools / executeToolsParallel / maybeAdvancePhase` — 行为已明确,见 v2 §3.4 / §3.2 / §3.5 / §3.1
- `callLLM / parseThought` — 标准库式实现,见 §1.5 buildSystemPrompt
- **本文档定义剩下的 5 个**:§1 `canFinish` / `forceContinuePrompt` / `validateToolCalls` / `applyToolEffects` / `buildSystemPrompt`

§2 给 `plan_transit` 和 `finalize_plan` 两个工具的完整定义。§3 给行程 JSON schema。

---

## 1. 5 个核心函数(行为锁定)

### 1.1 canFinish

```ts
function canFinish(state: AgentState, resp: LLMResponse): boolean {
  if (state.phase !== "completed") return false;

  const travelDays = computeTravelDays(state.preferences!);
  if (state.dayPlans?.length !== travelDays) return false;

  if (!state.budgetBreakdown) return false;

  // 防 LLM 过早结束:thought 含"还需要/继续/待"等继续信号 → 拒绝
  const CONTINUE_SIGNALS = ["还需要", "继续", "待补", "TODO", "下一步"];
  if (state.lastThought && CONTINUE_SIGNALS.some(s => state.lastThought!.includes(s))) {
    return false;
  }

  // budgetRound 超限 → 允许 finish(系统已尽力,budget 不达标也只能交付)
  return true;
}

function computeTravelDays(prefs: UserPreferences): number {
  const ms = new Date(prefs.endDate).getTime() - new Date(prefs.startDate).getTime();
  return Math.max(1, Math.floor(ms / 86_400_000));
}
```

**关键不变量**:
- 只在 `phase === "completed"` 时返回 true
- `dayPlans.length === travelDays` 必须严格匹配
- `lastThought` 检测继续信号防止 LLM "草率收尾"

**测试**:`src/runtime/__tests__/can-finish.test.ts` — table-driven,覆盖 12 个 case。

### 1.2 forceContinuePrompt

```ts
function forceContinuePrompt(state: AgentState): string {
  const missing = getMissingRequirements(state);
  const hints = PHASE_HINTS[state.phase];

  return `你当前在 ${state.phase} 阶段,但尚未满足完成条件。

【缺少的必要信息】
${missing.map(m => `- ${m}`).join("\n")}

【下一步建议】
${hints}

请直接调用工具继续,不要等待用户输入。再次提醒:必须在调用工具前用 <thought>...</thought> 说明你的推理。`;
}

const PHASE_HINTS: Record<Phase, string> = {
  gathering:    "继续调用 collect_preferences 收集用户偏好(destination/departureCity/startDate/endDate/numTravelers/budget)。",
  searching:    "并行调用 search_baike / search_attractions / search_hotels / search_xhs / search_restaurants(scope=city)。",
  selecting:    "调用 select_transport(outboundId, returnId) 和 select_hotel(hotelId),让用户从候选中选择。",
  planning:     "对每一天调 plan_transit(从前一景点到后一景点);最后调 finalize_plan 输出完整 JSON。",
  completed:    "已完成,无需继续。",
};

function getMissingRequirements(state: AgentState): string[] {
  const missing: string[] = [];
  switch (state.phase) {
    case "gathering": {
      const p = state.preferences;
      if (!p?.destination) missing.push("destination");
      if (!p?.departureCity) missing.push("departureCity");
      if (!p?.startDate) missing.push("startDate");
      if (!p?.endDate) missing.push("endDate");
      if (!p?.numTravelers) missing.push("numTravelers");
      if (!p?.budget) missing.push("budget");
      break;
    }
    case "searching": {
      if (!state.candidateTransports?.length) missing.push("candidateTransports (search_flights/trains)");
      if (!state.candidateHotels?.length) missing.push("candidateHotels (search_hotels)");
      if (!state.baikeKnowledge) missing.push("baikeKnowledge (search_baike)");
      break;
    }
    case "selecting": {
      if (!state.selectedOutbound) missing.push("selectedOutbound");
      if (!state.selectedReturn) missing.push("selectedReturn");
      if (!state.selectedHotel) missing.push("selectedHotel");
      break;
    }
    case "planning": {
      const travelDays = computeTravelDays(state.preferences!);
      if ((state.dayPlans?.length ?? 0) < travelDays) missing.push(`dayPlans (need ${travelDays}, have ${state.dayPlans?.length ?? 0})`);
      if (!state.budgetBreakdown) missing.push("budgetBreakdown");
      break;
    }
  }
  return missing;
}
```

### 1.3 validateToolCalls

4 类校验,任一失败即 push 到 `validation.rejected` 并附带原因。同一 iteration 内所有 rejected 合并为一条 rejection prompt。

```ts
interface ValidationResult {
  approved: ToolCall[];
  rejected: Array<{ call: ToolCall; reason: string; code: ValidationCode }>;
}

type ValidationCode =
  | "PHASE_NOT_ALLOWED"        // 当前 phase 不允许此工具
  | "SCHEMA_INVALID"           // Zod 校验失败
  | "DUPLICATE_CALL"           // 同一 iter 内同名+同参工具重复
  | "PRECONDITION_MISSING"     // 工具要求的前置 state 字段为空
  | "QPS_THROTTLED";           // (非拒绝)放入队列,trace 记 amap_wait_ms

function validateToolCalls(
  calls: ToolCall[],
  state: AgentState,
  registry: ToolRegistry,
): ValidationResult {
  const approved: ToolCall[] = [];
  const rejected: ValidationResult["rejected"] = [];
  const seen = new Set<string>();

  for (const call of calls) {
    // 1. Phase gating
    if (!isToolAllowedInPhase(call.name, state.phase)) {
      rejected.push({ call, code: "PHASE_NOT_ALLOWED",
        reason: `${call.name} 在 ${state.phase} 阶段不可用。可用工具:${listToolsForPhase(state.phase).join(", ")}` });
      continue;
    }

    // 2. Schema(Zod)
    const schema = registry.getSchema(call.name);
    const parsed = schema.safeParse(call.input);
    if (!parsed.success) {
      rejected.push({ call, code: "SCHEMA_INVALID",
        reason: `参数校验失败:${parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}` });
      continue;
    }

    // 3. 去重(同名 + 同参 hash)
    const dedupKey = `${call.name}:${stableHash(parsed.data)}`;
    if (seen.has(dedupKey)) {
      rejected.push({ call, code: "DUPLICATE_CALL",
        reason: `本轮已调用过 ${call.name}(相同参数),请勿重复。` });
      continue;
    }
    seen.add(dedupKey);

    // 4. 前置 state
    const precond = PRECONDITIONS[call.name];
    if (precond && !precond.check(state)) {
      rejected.push({ call, code: "PRECONDITION_MISSING",
        reason: `${call.name} 要求前置条件不满足:${precond.desc}` });
      continue;
    }

    approved.push({ ...call, input: parsed.data });
  }

  return { approved, rejected };
}

const PRECONDITIONS: Record<string, { check: (s: AgentState) => boolean; desc: string }> = {
  select_transport: {
    check: s => (s.candidateTransports?.length ?? 0) > 0,
    desc: "candidateTransports 不为空",
  },
  select_hotel: {
    check: s => (s.candidateHotels?.length ?? 0) > 0,
    desc: "candidateHotels 不为空",
  },
  finalize_plan: {
    check: s => Boolean(s.selectedOutbound && s.selectedReturn && s.selectedHotel),
    desc: "selectedOutbound + selectedReturn + selectedHotel 都已选",
  },
  // search_restaurants(scope=attraction) 要求 candidateAttractions 非空(planning 阶段)
};
```

**关键点**:
- rejected 不是 fatal,LLM 收到 rejection 后继续 Loop
- 同 iter 连续 3 次 rejection → `force_finish`(避免无限循环,见 redesign §6.2)

### 1.4 applyToolEffects(state reducer)

这是 Loop 的"写入逻辑",**全程 immutable**(每次返回新 state 对象)。

#### 工具 → state 字段映射表

| 工具 | 写入字段 | 其他副作用 |
|------|----------|------------|
| `collect_preferences` | `preferences` | phase 检查(可能触发 gathering → searching) |
| `search_baike` | `baikeKnowledge` | — |
| `search_weather` | `weather` | — |
| `search_attractions` | `candidateAttractions`(append) | `rerankScores[<name>] = score` |
| `search_hotels` | `candidateHotels`(append) | `rerankScores[<name>] = score` |
| `search_restaurants`(scope=city) | `candidateRestaurants`(append) | `rerankScores[<name>] = score` |
| `search_restaurants`(scope=attraction) | `planningRestaurants`(append,按 near 分组) | 同上 |
| `search_xhs` | `xhsNotes`(append,dedupe by noteId) | — |
| `search_travel_guides` | (写入临时 message 内容,不进 state) | — |
| `select_transport` | `selectedOutbound` + `selectedReturn` | — |
| `select_hotel` | `selectedHotel` | — |
| `plan_transit` | `dayPlans[<dayIdx>].transits`(append) | — |
| `finalize_plan` | `dayPlans` + `budgetBreakdown` | **见 budgetRound 逻辑** |
| (任何工具失败) | `toolErrors[<toolName>] = msg` | `fallbackUsage[<toolName>]++`(若 fallback_level > 0) |

#### budgetRound increment 时机

`finalize_plan` 工具内部判断预算:

```ts
// src/tools/definitions/finalize-plan.ts
async execute(input, { state }) {
  const plan = parsePlanLoose(input.rawJson, PlanSchema);  // 三层修复
  const breakdown = computeBudgetBreakdown(plan, state);

  return {
    success: true,
    data: { plan, breakdown, withinBudget: breakdown.isWithinBudget },
    fallbackLevel: 0,
  };
}

// src/runtime/apply-tool-effects.ts
function applyFinalizePlan(state: AgentState, result: FinalizeResult): AgentState {
  const next: AgentState = {
    ...state,
    dayPlans: result.plan.dayPlans,
    budgetBreakdown: result.breakdown,
  };

  if (!result.withinBudget && state.budgetRound < MAX_BUDGET_ROUNDS) {
    next.budgetRound = state.budgetRound + 1;
    next.phase = "planning";  // 强制回退,让 LLM 重排
    // 在 messages 里追加 budget feedback,提示 LLM 调整
    next._pendingBudgetFeedback = budgetExceedPrompt(result.breakdown, state.preferences!);
  } else if (result.withinBudget) {
    next.phase = "completed";
  } else {
    // budgetRound >= MAX,放行交付
    next.phase = "completed";
    next.errorMessages.push(`Budget exceeded after ${MAX_BUDGET_ROUNDS} rounds, delivering best-effort plan`);
  }

  return next;
}
```

**核心不变量**:
- budgetRound 在 `applyFinalizePlan` 内 +1,**仅在 budget 不达标且未超上限时**
- phase 回退到 "planning" + 在 messages 注入 budget feedback,LLM 拿到具体差额后调整
- 超过 MAX_BUDGET_ROUNDS(默认 3)→ 强制交付

#### reducer 实现

```ts
function applyToolEffects(state: AgentState, results: ToolResult[]): AgentState {
  let next = state;
  for (const result of results) {
    if (!result.success) {
      next = {
        ...next,
        toolErrors: { ...next.toolErrors, [result.toolName]: result.error ?? "unknown" },
        fallbackUsage: result.fallbackLevel > 0
          ? { ...next.fallbackUsage, [result.toolName]: (next.fallbackUsage[result.toolName] ?? 0) + 1 }
          : next.fallbackUsage,
      };
      continue;
    }

    const handler = TOOL_EFFECT_HANDLERS[result.toolName];
    if (handler) {
      next = handler(next, result.data);
    }
  }
  return next;
}

const TOOL_EFFECT_HANDLERS: Record<string, (s: AgentState, data: any) => AgentState> = {
  collect_preferences:       (s, d) => ({ ...s, preferences: mergePrefs(s.preferences, d) }),
  search_baike:              (s, d) => ({ ...s, baikeKnowledge: d.summary }),
  search_weather:            (s, d) => ({ ...s, weather: d }),
  search_attractions:        (s, d) => appendCandidates(s, "candidateAttractions", d.items, d.scores),
  search_hotels:             (s, d) => appendCandidates(s, "candidateHotels", d.items, d.scores),
  search_restaurants:        (s, d) => d.scope === "city"
                                          ? appendCandidates(s, "candidateRestaurants", d.items, d.scores)
                                          : appendPlanningRestaurants(s, d.near, d.items, d.scores),
  search_xhs:                (s, d) => mergeXhsNotes(s, d.notes),
  select_transport:          (s, d) => ({ ...s, selectedOutbound: d.outbound, selectedReturn: d.return }),
  select_hotel:              (s, d) => ({ ...s, selectedHotel: d.hotel }),
  plan_transit:              (s, d) => appendTransit(s, d.dayIdx, d.transit),
  finalize_plan:             (s, d) => applyFinalizePlan(s, d),
};
```

### 1.5 buildSystemPrompt

base prompt(所有 phase 共享)+ phase 扩展段(动态注入)+ 当前 state 摘要。

```ts
function buildSystemPrompt(state: AgentState): string {
  return [
    BASE_PROMPT,
    "",
    PHASE_PROMPTS[state.phase],
    "",
    "【当前 state 摘要】",
    stateSummary(state),
    "",
    "【可用工具(本 phase)】",
    listToolsForPhase(state.phase).map(t => `- ${t.name}: ${t.description}`).join("\n"),
  ].join("\n");
}

const BASE_PROMPT = `你是一个旅行规划 Agent,通过工具调用完成多阶段任务。

【ReAct 推理要求】
在每次决策前,你必须先用 <thought>...</thought> 块输出推理,内容包括:
1. 当前 phase 与已有信息(1 句)
2. 下一步要做什么、为什么(1-2 句)
3. 拟调用的工具与关键参数

示例:
<thought>
phase=searching, 已有目的地东京 + 偏好Comfort。下一步需要并行获取
景点/酒店/小红书真实评价。调用 search_attractions/xhs/hotels。
</thought>

【并行调用】
当需要检索多个独立信息源(景点/酒店/小红书/百科),请一次性并行调用所有相关工具,而非逐个。

【JSON 输出】
finalize_plan 工具的 rawJson 字段必须是合法 JSON,不要省略花括号或逗号。

【约束】
- 不要在 gathering 阶段调用 search_*
- 不要在 planning 阶段调用 collect_preferences
- 同一轮内不要用相同参数重复调用同一工具
`;

const PHASE_PROMPTS: Record<Phase, string> = {
  gathering: `【当前阶段:gathering(收集偏好)】
任务:通过 collect_preferences 工具获取用户的:destination / departureCity / startDate / endDate / numTravelers / budget / accommodationStyle / travelInterests 等。

下一阶段:当必填字段齐全 → searching(自动触发,你不需要操心)。
`,
  searching: `【当前阶段:searching(并行检索)】
任务:并行调用 search_baike / search_attractions / search_hotels / search_xhs / search_restaurants(scope=city),一次性获取目的地核心信息。

约束:
- 高德 API 全局限流 3 QPS,代码层会排队,你不用考虑
- search_xhs 默认抓 30 篇,不够会自动再抓 30
- 餐厅 search 用 scope=city(城市热门),不要在这个阶段用 scope=attraction

下一阶段:候选齐全 → selecting。
`,
  selecting: `【当前阶段:selecting(用户选择)】
任务:向用户推送交通候选(去程+返程)和酒店候选,等待用户用 select_transport / select_hotel 工具确认。

约束:
- select_transport 需要 outboundId + returnId 两个参数
- select_hotel 需要 hotelId
- 推送时要按 rerankScores 排序,推荐项标 isRecommended=true

下一阶段:三个 select 字段齐全 → planning。
`,
  planning: `【当前阶段:planning(行程编排)】
任务:为每一天编排景点 + 衔接交通 + 餐厅。最后调 finalize_plan 输出完整 JSON。

约束:
- 景点→景点之间必须用 plan_transit 工具查市内交通
- 餐厅要用 scope=attraction + near=<景点名>(景点级搜索)
- 餐厅多样性:本地特色 ≤60%、排除连锁(除非用户显式要求)
- finalize_plan 失败会回退到 planning,budgetRound+1,最多重试 3 次

JSON schema 见 finalize_plan 工具描述。`,
  completed: `【当前阶段:completed】
行程已交付,等待用户反馈或新指令。`,
};
```

---

## 2. 2 个未完整设计的工具

### 2.1 plan_transit(市内交通规划)

```ts
// src/tools/definitions/plan-transit.ts
export const planTransitTool: RegisteredTool = {
  name: "plan_transit",
  description: "查询两个地点之间的市内交通方案(地铁/公交/步行/出租车)。用于景点→景点、酒店→景点之间的衔接。",
  input_schema: {
    type: "object",
    properties: {
      from:     { type: "string", description: "起点:景点名 / 酒店名 / 地址" },
      to:       { type: "string", description: "终点:景点名 / 酒店名 / 地址" },
      dayIdx:   { type: "integer", description: "第几天(0-based),用于写入 dayPlans[dayIdx].transits", minimum: 0 },
      departAt: { type: "string", description: "出发时间 HH:MM,可选,影响路况", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" },
      mode:     { type: "string", enum: ["transit", "walking", "driving", "rideshare"], default: "transit" },
    },
    required: ["from", "to", "dayIdx"],
  },
  metadata: { phase: ["planning"], timeout: 8000, fallback: "haversine_estimate" },

  async execute(input, ctx) {
    const amapKey = settings.AMAP_API_KEY;
    const start = await geocode(input.from, amapKey);   // 高德地理编码
    const end = await geocode(input.to, amapKey);

    const resp = await callAmap(async () =>
      fetch(`https://restapi.amap.com/v3/direction/transit/integrated`
        + `?key=${amapKey}&origin=${start.lng},${start.lat}&destination=${end.lng},${end.lat}`
        + `&city=全国&strategy=0`).then(r => r.json())
    );

    if (!resp.route?.transits?.length) {
      return { success: false, data: null, error: "No transit route found" };
    }

    const transit = resp.route.transits[0];
    return {
      success: true,
      fallbackLevel: 0,
      data: {
        dayIdx: input.dayIdx,
        transit: {
          from: input.from,
          to: input.to,
          mode: "transit",
          durationMin: Math.round(transit.duration / 60),
          distanceKm: Math.round(transit.distance / 100) / 10,
          cost: transit.cost || "未知",
          steps: transit.segments.map((seg: any) =>
            `${seg.bus?.buslines?.[0]?.name ?? "步行"} ${seg.instruction ?? ""}`.trim()
          ),
        },
      },
    };
  },
};
```

**降级链**:
- L0: 高德路径规划 API(主)
- L1: 高德 API 失败/超时 → Haversine 直线距离 + 平均速度假设(地铁 25km/h,公交 18km/h,步行 5km/h)+ 估算成本
- L2: 地理编码失败(景点名找不到)→ 返回错误,LLM 收到后换用相邻已知景点

trace 字段:
```jsonl
{"type":"tool_exec","tool":"plan_transit","duration_ms":1200,"fallback_level":0,
 "data_summary":{"from":"故宫","to":"天坛","durationMin":35,"cost":"¥4"}}
```

### 2.2 finalize_plan(行程交付)

```ts
// src/tools/definitions/finalize-plan.ts
export const finalizePlanTool: RegisteredTool = {
  name: "finalize_plan",
  description: "交付完整行程 JSON。代码层会用三层防御解析(正则提取 + JSON.parse + jsonrepair),Zod 校验,失败时回退让你重试。",
  input_schema: {
    type: "object",
    properties: {
      rawJson: { type: "string", description: "完整行程 JSON 字符串,结构见 DayPlan schema" },
    },
    required: ["rawJson"],
  },
  metadata: { phase: ["planning"], timeout: 5000 },

  async execute(input, ctx) {
    const plan = parsePlanLoose(input.rawJson, PlanSchema);  // 见 §3
    const breakdown = computeBudgetBreakdown(plan, ctx.state);
    return {
      success: true,
      fallbackLevel: 0,
      data: {
        plan,
        breakdown,
        withinBudget: breakdown.isWithinBudget,
      },
    };
  },
};
```

**maxRetries=3 流程**(见 redesign v2 §3.3):
- LLM 调 finalize_plan → parsePlanLoose 抛错 → 不返回 ToolResult,而是 push `parse_error` user message → 重新进 Loop(LLM 再调 finalize_plan)
- 计数到 3 次仍失败 → throw `JsonRepairExhaustedError`,Loop 捕获,降级到 ActivityAgent 兜底(沿用现状)

---

## 3. 行程 JSON Schema(`DayPlan` + `BudgetBreakdown`)

### 3.1 TypeScript types

```ts
interface TravelPlan {
  destination: string;
  startDate: string;          // YYYY-MM-DD
  endDate: string;
  travelers: number;
  dayPlans: DayPlan[];
  budgetBreakdown: BudgetBreakdown;
  warnings: string[];         // priceWarnings + budget 警告
}

interface DayPlan {
  dayIdx: number;             // 0-based
  date: string;               // YYYY-MM-DD
  theme?: string;             // 当日主题(如"浅草 + 晴空塔")
  morning?: ItinerarySlot;
  afternoon?: ItinerarySlot;
  evening?: ItinerarySlot;
  dining: DiningPlan[];       // 早/午/晚
  transitTips: string[];      // 市内交通要点(来自 plan_transit)
}

interface ItinerarySlot {
  attractions: Activity[];    // 1-2 个景点
  transitToNext?: TransitSegment;  // 到下一 slot 的交通
  notes?: string;
}

interface DiningPlan {
  meal: "breakfast" | "lunch" | "dinner";
  restaurant?: Activity;      // 可能跳过(如航班时段)
  alternatives?: string[];    // 1-2 个备选
  isLocalSpecialty: boolean;
}

interface Activity {
  name: string;
  category: "attraction" | "restaurant" | "hotel" | "shopping";
  location: { lat: number; lng: number; address: string };
  estimatedDurationMin: number;
  estimatedCost: number;
  description: string;        // 100-300 字,含特色 / 注意事项
  source: "amap" | "xhs" | "rag" | "baike" | "llm_generated";
  rerankScore: number;        // 来自 §4.3 公式
}

interface TransitSegment {
  from: string;
  to: string;
  mode: "transit" | "walking" | "driving" | "rideshare";
  durationMin: number;
  distanceKm: number;
  cost: string;               // "¥4" / "未知"
  steps: string[];            // 高德返回的换乘指南
  fallbackLevel: 0 | 1 | 2;
}

interface BudgetBreakdown {
  totalCost: number;
  byCategory: {
    transport: number;        // 含城际交通 + 市内
    accommodation: number;
    food: number;
    attractions: number;      // 门票
    other: number;
  };
  budgetLimit: number;
  isWithinBudget: boolean;
  variance: number;           // totalCost - budgetLimit(负=节省)
  suggestions?: string[];     // 超预算时的调整建议
}
```

### 3.2 Zod schema

```ts
import { z } from "zod";

const ActivitySchema = z.object({
  name: z.string().min(1),
  category: z.enum(["attraction", "restaurant", "hotel", "shopping"]),
  location: z.object({
    lat: z.number(),
    lng: z.number(),
    address: z.string(),
  }),
  estimatedDurationMin: z.number().int().positive(),
  estimatedCost: z.number().nonnegative(),
  description: z.string().min(50).max(500),
  source: z.enum(["amap", "xhs", "rag", "baike", "llm_generated"]),
  rerankScore: z.number().min(0).max(1),
});

const TransitSegmentSchema = z.object({
  from: z.string(),
  to: z.string(),
  mode: z.enum(["transit", "walking", "driving", "rideshare"]),
  durationMin: z.number().positive(),
  distanceKm: z.number().nonnegative(),
  cost: z.string(),
  steps: z.array(z.string()),
  fallbackLevel: z.union([z.literal(0), z.literal(1), z.literal(2)]),
});

const DiningPlanSchema = z.object({
  meal: z.enum(["breakfast", "lunch", "dinner"]),
  restaurant: ActivitySchema.optional(),
  alternatives: z.array(z.string()).max(3).optional(),
  isLocalSpecialty: z.boolean(),
});

const ItinerarySlotSchema = z.object({
  attractions: z.array(ActivitySchema).min(1).max(3),
  transitToNext: TransitSegmentSchema.optional(),
  notes: z.string().optional(),
});

const DayPlanSchema = z.object({
  dayIdx: z.number().int().nonnegative(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  theme: z.string().optional(),
  morning: ItinerarySlotSchema.optional(),
  afternoon: ItinerarySlotSchema.optional(),
  evening: ItinerarySlotSchema.optional(),
  dining: z.array(DiningPlanSchema).length(3),
  transitTips: z.array(z.string()),
});

const BudgetBreakdownSchema = z.object({
  totalCost: z.number().nonnegative(),
  byCategory: z.object({
    transport: z.number().nonnegative(),
    accommodation: z.number().nonnegative(),
    food: z.number().nonnegative(),
    attractions: z.number().nonnegative(),
    other: z.number().nonnegative(),
  }),
  budgetLimit: z.number().positive(),
  isWithinBudget: z.boolean(),
  variance: z.number(),
  suggestions: z.array(z.string()).optional(),
});

const TravelPlanSchema = z.object({
  destination: z.string(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  travelers: z.number().int().positive(),
  dayPlans: z.array(DayPlanSchema),
  budgetBreakdown: BudgetBreakdownSchema,
  warnings: z.array(z.string()),
});

export const PlanSchema = TravelPlanSchema;
```

### 3.3 Mock JSON 示例(测试用 + 给 LLM 参考)

```json
{
  "destination": "东京",
  "startDate": "2026-07-01",
  "endDate": "2026-07-05",
  "travelers": 2,
  "dayPlans": [
    {
      "dayIdx": 0,
      "date": "2026-07-01",
      "theme": "浅草 + 晴空塔",
      "morning": {
        "attractions": [
          {
            "name": "浅草寺",
            "category": "attraction",
            "location": { "lat": 35.7148, "lng": 139.7967, "address": "东京都台东区浅草2-3-1" },
            "estimatedDurationMin": 120,
            "estimatedCost": 0,
            "description": "东京最古老的寺院,雷门灯笼是地标。建议早 9 点前到达避开人群,体验仲见世通商业街小吃。",
            "source": "amap",
            "rerankScore": 0.92
          }
        ],
        "transitToNext": {
          "from": "浅草寺",
          "to": "晴空塔",
          "mode": "walking",
          "durationMin": 15,
          "distanceKm": 1.2,
          "cost": "¥0",
          "steps": ["沿隅田川步行"],
          "fallbackLevel": 0
        }
      },
      "afternoon": {
        "attractions": [
          {
            "name": "东京晴空塔",
            "category": "attraction",
            "location": { "lat": 35.7101, "lng": 139.8107, "address": "东京都墨田区押上1-1-13" },
            "estimatedDurationMin": 180,
            "estimatedCost": 2100,
            "description": "634 米世界最高塔,展望台看东京全景。建议买 350m + 450m 联票。",
            "source": "xhs",
            "rerankScore": 0.88
          }
        ]
      },
      "dining": [
        {
          "meal": "breakfast",
          "alternatives": ["酒店内", "便利店"],
          "isLocalSpecialty": false
        },
        {
          "meal": "lunch",
          "restaurant": {
            "name": "浅草今半",
            "category": "restaurant",
            "location": { "lat": 35.7128, "lng": 139.7938, "address": "台东区浅草3-1-12" },
            "estimatedDurationMin": 60,
            "estimatedCost": 2500,
            "description": "百年寿喜烧老店,黑毛和牛入口即化。午餐套餐 ¥2500 性价比高。",
            "source": "xhs",
            "rerankScore": 0.85
          },
          "isLocalSpecialty": true
        },
        {
          "meal": "dinner",
          "restaurant": {
            "name": "叙々苑 晴空塔店",
            "category": "restaurant",
            "location": { "lat": 35.7101, "lng": 139.8107, "address": "墨田区押上1-1-13" },
            "estimatedDurationMin": 90,
            "estimatedCost": 6000,
            "description": "高端烧肉,窗边位看东京塔夜景。",
            "source": "rag",
            "rerankScore": 0.78
          },
          "isLocalSpecialty": false
        }
      ],
      "transitTips": [
        "浅草→晴空塔步行 15 分钟,沿隅田川,天气好推荐走",
        "回酒店乘地铁银座线到浅草桥站,转 JR 总武线"
      ]
    }
  ],
  "budgetBreakdown": {
    "totalCost": 14200,
    "byCategory": {
      "transport": 800,
      "accommodation": 4500,
      "food": 8500,
      "attractions": 2100,
      "other": -1700
    },
    "budgetLimit": 15000,
    "isWithinBudget": true,
    "variance": -800,
    "suggestions": []
  },
  "warnings": [
    "浅草寺 7月 平均高温 31°C,带防晒"
  ]
}
```

---

## 4. xhs-service 对接细节

**已存在**(`xhs-service/main.py:12`):

| 端点 | 请求 | 响应 |
|------|------|------|
| `GET /xhs/health` | — | `{status, cookie_valid}` |
| `POST /xhs/search` | `{query: string, limit: int=5}` | `{success, notes[], error?}` |
| `POST /xhs/note` | `{url: string}` | `{success, note?, error?}` |

**search_xhs 工具实现**(P0-B):

```ts
// src/tools/definitions/search-xhs.ts
const XHS_SERVICE_URL = settings.XHS_SERVICE_URL;  // http://127.0.0.1:3220

async execute(input, ctx) {
  const limit = input.limit ?? 30;
  const extractMore = input.extractMore ?? 30;

  // L0: xhs-service 主源
  let notes = await callXhsWithRetry(input.query, limit);

  // 不够(limit/2 以下)→ 渐进抓取,query 同义词扩展
  if (notes.length < limit / 2) {
    const expanded = expandQuery(input.query);  // "东京美食" → ["东京美食", "东京必吃", "东京推荐餐厅"]
    const more = await Promise.all(
      expanded.slice(1).map(q => callXhsWithRetry(q, extractMore / expanded.length))
    );
    notes = dedupeByNoteId([...notes, ...more.flat()]);
  }

  // 全量存 state,top-10 返给 LLM
  const ranked = rerankXhs(notes, ctx.state.preferences!);
  return {
    success: true,
    fallbackLevel: 0,
    data: {
      notes: ranked.slice(0, 10),  // 给 LLM 看的精简版
      total: notes.length,
      _all_notes_stored_in_state: true,
    },
  };
}

async function callXhsWithRetry(query: string, limit: number): Promise<XhsNote[]> {
  try {
    const r = await fetch(`${XHS_SERVICE_URL}/xhs/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit }),
      signal: AbortSignal.timeout(15_000),
    });
    if (r.status === 429) throw new RateLimitError();
    if (!r.ok) throw new Error(`xhs-service ${r.status}`);
    const data = await r.json();
    return data.success ? data.notes : [];
  } catch (err) {
    return [];  // 降级由上层 fallback 链处理
  }
}
```

**fallback 链**(`policy.ts`):
```ts
const TOOL_FALLBACK_CHAIN = {
  search_xhs: [
    "xhs_service",                  // L0
    "web_search_site_filter",       // L1: WebSearch "site:xiaohongshu.com {query}"
    "rag_travel_guides",            // L2: RAG 中 source=xhs 的笔记
  ],
};
```

---

## 5. RAG plan 补丁(回应 review §4)

### 5.1 Ground truth 标注工具

新增 `scripts/label-tool.ts`(P1-B 第 3 步):

```ts
// 交互式标注:readline 显示 query + 当前 RAG top-20 chunks 摘要,人工 y/n
import readline from "readline";

async function main() {
  const queries = await loadJsonl("data/rag/eval-v1-raw.jsonl");
  const labeled: EvalItem[] = [];

  for (const q of queries) {
    const hits = await ragSource.search(q.query, 20);  // 当前 RAG top-20
    console.log(`\nQuery [${q.id}] (${q.category}): ${q.query}\n`);
    hits.forEach((h, i) => console.log(`  [${i + 1}] ${h.chunkId} (score ${h.score.toFixed(3)}) ${h.text.slice(0, 80)}...`));

    const positiveIdx = await askUser("标记正样本编号(逗号分隔,空跳过): ");
    const groundTruthDocIds = positiveIdx
      .split(",").map(s => s.trim()).filter(Boolean).map(n => hits[parseInt(n) - 1]?.chunkId).filter(Boolean);
    labeled.push({ ...q, groundTruthDocIds, reviewer: process.env.USER, version: "v1" });
  }

  await writeJsonl("data/rag/eval-v1.jsonl", labeled);
}
```

**估时调整**:P1-B 第 3 步(人工校验 + 标注)从 1 天调整为 1.5 天(含工具开发)。

### 5.2 chunk ID 稳定性

**采用内容 hash 作为 chunk ID**(SHA-256 前 12 位):

```ts
// src/rag/corpus-loader.ts
function makeChunkId(content: string): string {
  return "chunk-" + createHash("sha256").update(content).digest("hex").slice(0, 12);
}
```

**好处**:V1/V2/V6 改 chunk size 后,内容相同的 chunk ID 保持稳定,ground truth 自动迁移。
**坏处**:内容稍改(标点变化)就换 ID → 实际中可以接受,因为 rerank 不依赖 ID 完全对齐。

### 5.3 V6 改为"必跑"(决策树修订)

```
V5 失败 → 直接进 V6(重切分),不再标记为"兜底可能省掉"
```

redesign §6 决策树更新。

### 5.4 Bootstrap 显著性阈值

```ts
// scripts/rag-compare.ts
const SIGNIFICANCE = {
  minDeltaHitRate: 0.03,    // Δ Hit Rate ≥ 3%
  maxPValue: 0.05,          // p < 0.05
  bootstrapIterations: 1000,
};

function isSignificant(baseline: number[], variant: number[]): {
  delta: number; ci: [number, number]; pValue: number; significant: boolean;
} {
  const delta = mean(variant) - mean(baseline);
  const ci = bootstrapCI(baseline, variant, 1000);  // 95% CI
  const pValue = permutationTest(baseline, variant, 1000);
  return {
    delta,
    ci,
    pValue,
    significant: delta >= SIGNIFICANCE.minDeltaHitRate && pValue < SIGNIFICANCE.maxPValue,
  };
}
```

**采用判定**:`significant = true`。

---

## 6. 文档一致性补丁(回应 review §5)

### 6.1 Prompt 版本路径统一

**采用**:`docs/prompt-versions/`(和 redesign v2 一致)

修正 `docs/optimization-log.md` 模板里 `prompts/versions/system-v{N}.md` → `docs/prompt-versions/system-v{N}.md`。

### 6.2 optimization-log A/B 指标修正

把 `JSON 解析失败率` 替换为更有意义的 prompt 质量指标:

```markdown
| 指标 | v{N}(基线) | v{N+1}(新) | Δ |
|------|-----------|------------|---|
| 自评均分(50 case) | ? | ? | ? |
| 用户评分均分 | ? | ? | ? |
| 行程完整度(dayPlans 覆盖率) | ?% | ?% | ? |
| 餐厅多样性分(本地特色比例) | ?% | ?% | ? |
| 预算偏差率 | ?% | ?% | ? |
| 平均工具调用次数 | ? | ? | ? |
| 平均 latency | ?ms | ?ms | ? |
```

### 6.3 budgetRound increment 时机

见 §1.4 `applyFinalizePlan` 实现,已写入。redesign v2 §3.1 AgentState 字段描述里加引用 "(increment 时机见 p0-a-contracts §1.4)"。

---

## 7. P0-A 文件级 step plan

按文件拆 sub-task,每个 sub-task 是独立 commit。

### Step 1:AgentState + Phase 转换(types only)

文件:`src/runtime/state.ts`
内容:
- 导出 `Phase` 类型
- 导出 `AgentState` interface(v2 §3.1 字段全)
- 导出 `computeTravelDays`
- 导出 `maybeAdvancePhase`(纯函数,基于 v2 §3.1 转换条件)
- 导出 `canFinish`(见 §1.1)

测试:`src/runtime/__tests__/state.test.ts`(table-driven,覆盖 5 个 phase 转换 + canFinish 12 case)

Commit:`feat(runtime): AgentState type + phase transition + canFinish`

### Step 2:Trace 系统

文件:`src/runtime/trace.ts`
内容:
- `TraceEvent` union type
- `trace(type, payload)` 写入 `data/trace/{sid}.jsonl`(append)
- `parseThought(text)` 解析 `<thought>` 块

测试:`trace.test.ts`(jsonl 写入 + thought 解析正则)

Commit:`feat(runtime): structured trace with thought parsing`

### Step 3:Tool registry + policy

文件:`src/tools/policy.ts`、`src/tools/registry.ts`(改造现有)
内容:
- `isToolAllowedInPhase` / `listToolsForPhase`
- `TOOL_FALLBACK_CHAIN` 表(v2 §4.7)
- `amapLimiter`(令牌桶 capacity=3)

测试:`policy.test.ts`(phase gating 表驱动 + QPS 限流模拟)

Commit:`feat(tools): phase gating policy + amap QPS limiter`

### Step 4:validateToolCalls

文件:`src/runtime/validate-tool-calls.ts`
内容:§1.3 完整实现
测试:5 类 ValidationCode 各 2 case

Commit:`feat(runtime): tool call validation (phase/schema/dedup/precondition)`

### Step 5:applyToolEffects reducer

文件:`src/runtime/apply-tool-effects.ts`
内容:§1.4 完整实现 + 13 个 TOOL_EFFECT_HANDLERS + applyFinalizePlan
测试:每个 handler 单独测,applyFinalizePlan 覆盖 withinBudget / 超 budget / 超 MAX 三种

Commit:`feat(runtime): immutable state reducer + finalize_plan budget logic`

### Step 6:Agent Loop 主循环

文件:`src/runtime/agent-loop.ts`
内容:v2 §3.3 完整实现 + 引用前 5 step 的函数
测试:用 mock LLM 跑 5 个 phase 全流程,验证 phase 转换 + thought 解析 + tool execution

Commit:`feat(runtime): Agent Loop main loop with ReAct thought`

### Step 7:plan_transit + finalize_plan 工具

文件:`src/tools/definitions/plan-transit.ts`、`src/tools/definitions/finalize-plan.ts`
内容:§2 完整实现 + PlanSchema §3.2 + parsePlanLoose
测试:工具单测 + PlanSchema Zod 校验 + mock JSON 通过

Commit:`feat(tools): plan_transit + finalize_plan with JSON schema`

### Step 8:buildSystemPrompt

文件:`src/runtime/system-prompt.ts`
内容:§1.5 完整实现(BASE + 5 个 PHASE_PROMPTS + state 摘要 + 可用工具列表)
测试:snapshot test 5 个 phase 的 prompt 输出

Commit:`feat(runtime): phase-specific system prompt builder`

### Step 9:集成 + E2E

文件:`src/runtime/index.ts`(barrel) + `src/runtime/__tests__/e2e.test.ts`
内容:用真实 LLM 跑 "下周去东京 5 天,预算 1.5 万" 全流程
验收:满足 v2 §8 P0 完成后前 7 条

Commit:`feat(runtime): e2e integration test + index barrel`

**P0-A 总估时**:7-9 天(比 v2 §5 的 5-7 天多 2 天,因加入契约文档要求的细节)

---

## 8. P0-A 启动检查清单

开工前确认:
- [ ] 本文档已 review
- [ ] redesign v2 已 review
- [ ] xhs-service 已确认可运行(`curl http://127.0.0.1:3220/xhs/health`)
- [ ] `data/rag/eval.jsonl` 当前真实 hit rate 已记录到 RAG plan §1
- [ ] git 主分支干净,新分支 `feat/p0-a-agent-loop` 已建
- [ ] 测试框架 vitest 已配置(P0-A 9 步都要 TDD)

review 通过后,开 `feat/p0-a-agent-loop` 分支,从 §7 Step 1 开始。
