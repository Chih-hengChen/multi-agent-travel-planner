# Agent Loop Redesign

> 立项日期:2026-06-16
> 状态:Draft,待 review
> 决策依据:Q1=A(代码控制)/ Q2=单 Loop / Q3=两级模型 / Q4=B+C / Q5=先扩 eval set

---

## 1. 设计目标

把"流程编排式"(TurnHandler + Pipeline 直线驱动)重构为"Agentic 式"(代码控制主循环 + LLM 单步决策)。

**核心特征(类 claude-code)**:
- Loop 主体在 TS,LLM 每轮只返回单步决策(tool_use 或最终答)
- 工具调用前后都过代码逻辑:权限校验、状态校验、重复检测、超时控制
- 单一 Agent Loop 处理所有阶段,phase 字段驱动工具可用集与模型选择
- LLM 无状态,代码维护 state 并把 history 全量传入

**次要目标**:
- 工具系统统一(消除当前 ToolRegistry 死代码 + LLMPlanAgent 内联定义的双轨)
- 并行检索(一次调多源,代码 rerank)
- JSON 鲁棒(代码 repair,不靠 prompt 祈祷)
- 可观测性(思考链 trace 可视化)
- 数据飞轮(评分回流 → 反哺 prompt)

---

## 2. 整体架构

### 2.1 数据流

```
HTTP /api/chat/:sid (SSE)
     │
     ▼
ConversationOrchestrator.handleMessage
     │  load ConversationContext (含 AgentState)
     ▼
┌─────────────────────────────────────────────────────────┐
│  Agent Loop  (src/runtime/agent-loop.ts)                │
│                                                          │
│   for iter in 0..MAX_ITER:                               │
│     1. pickModel(state.phase) → 小/大模型                 │
│     2. pickTools(state.phase) → 该阶段可用工具集          │
│     3. LLM.call(messages, tools) → response              │
│     4. trace("llm_response", response)                  │
│     5. if no tool_use:                                   │
│          if canFinish(state): → finalize                 │
│          else: push forceContinue → continue             │
│     6. validateToolCalls(response.toolCalls, state)      │
│        rejected → push rejection → continue              │
│     7. results = executeTools(approved, parallel=true)   │
│     8. push tool_results to messages                    │
│     9. state = applyToolEffects(state, results)         │
│    10. state = maybeAdvancePhase(state)                 │
│    11. emit SSE: progress / options / partial            │
│                                                          │
└─────────────────────────────────────────────────────────┘
     │
     ▼
finalize → buildPlanSummary → SSE tool_result → save trace → done
```

### 2.2 与当前架构的差异

| 维度 | 当前 | Redesign |
|------|------|----------|
| 主驱动 | TurnHandler 硬编码分支 + Pipeline 直线 | 单 Agent Loop |
| 状态机 | 双状态机(对话 11 + Pipeline 7,共 18) | 单 state object,phase 字段驱动 |
| 工具系统 | LLMPlanAgent 内联 5 工具 + ToolRegistry 8 工具(死代码) | 统一 ToolRegistry,12+ 工具按 phase 暴露 |
| 模型选择 | 各 Agent 硬编码 | `pickModel(phase, task)` 表驱动 |
| LLM 角色 | 不同 Agent 不同 prompt 模板 | 统一 system prompt 模板 + phase 提示 |
| 并行检索 | FlightAgent + HotelAgent 在 PipelineExecutor.allSettled | LLM parallel_tool_use 一次调多源 |
| 可观测性 | sessionLogger.jsonl 事件流 | 结构化 trace(每轮思考链) + timeline UI |

---

## 3. 核心组件

### 3.1 AgentState(替代 TravelPlanState + ConversationContext 的核心字段)

```ts
interface AgentState {
  phase: "gathering" | "searching" | "selecting" | "planning" | "completed";
  iteration: number;

  // 用户偏好(gathering 阶段填充)
  preferences?: UserPreferences;

  // 检索结果(searching 阶段填充)
  baikeKnowledge?: string;
  weather?: WeatherSummary;
  candidateAttractions?: Activity[];
  candidateHotels?: Hotel[];
  candidateRestaurants?: Activity[];
  xhsNotes?: XhsNote[];

  // 用户选择(selecting 阶段填充)
  selectedOutbound?: TransportOption;
  selectedReturn?: TransportOption;
  selectedHotel?: Hotel;

  // 行程(planning 阶段填充)
  dayPlans?: DayPlan[];
  budgetBreakdown?: BudgetBreakdown;

  // 元数据
  priceWarnings: string[];
  errorMessages: string[];
}
```

**Phase 转换条件**(纯代码判定,不靠 LLM):

| from → to | 条件 |
|-----------|------|
| gathering → searching | preferences 必填字段齐全 |
| searching → selecting | 至少 1 个交通候选 + 1 个酒店候选 |
| selecting → planning | selectedOutbound + selectedReturn + selectedHotel 都不为空 |
| planning → completed | dayPlans 非空 + budgetBreakdown.isWithinBudget 或 round ≥ maxRounds |

### 3.2 工具注册表

**目录结构**:

```
src/tools/
├── registry.ts              # ToolRegistry: register/get/execute/has
├── types.ts                 # RegisteredTool / ToolResult / ToolSchema
├── schemas/                 # 共享 Zod schema(消除 LLMPlanAgent 与 ToolRegistry 漂移)
│   ├── city.ts
│   ├── attraction.ts
│   └── hotel.ts
├── definitions/             # 工具实现
│   ├── collect-preferences.ts
│   ├── search-baike.ts      # 新
│   ├── search-attractions.ts
│   ├── search-restaurants.ts
│   ├── search-hotels.ts
│   ├── search-xhs.ts
│   ├── search-weather.ts
│   ├── search-travel-guides.ts
│   ├── plan-transit.ts      # 新:市内交通规划
│   ├── select-transport.ts  # 用户交互(返回 requiresUserInput)
│   ├── select-hotel.ts      # 用户交互
│   └── finalize-plan.ts     # 新:输出结构化 JSON
└── policy.ts                # 风险等级 + 超时 + 重试 + phase gating
```

**工具 phase 矩阵**:

| 工具 \ Phase | gathering | searching | selecting | planning |
|--------------|-----------|-----------|-----------|----------|
| collect_preferences | ✅ | ❌ | ❌ | ❌ |
| search_baike | ❌ | ✅ | ❌ | (已缓存) |
| search_weather | ❌ | ✅ | ❌ | (已缓存) |
| search_attractions | ❌ | ✅ | ❌ | ✅ |
| search_restaurants | ❌ | ❌ | ❌ | ✅ |
| search_hotels | ❌ | ✅ | ❌ | ❌ |
| search_xhs | ❌ | ✅ | ❌ | ✅ |
| search_travel_guides | ❌ | ✅ | ❌ | ✅ |
| plan_transit | ❌ | ❌ | ❌ | ✅ |
| select_transport | ❌ | ❌ | ✅ | ❌ |
| select_hotel | ❌ | ❌ | ✅ | ❌ |
| finalize_plan | ❌ | ❌ | ❌ | ✅ |

**phase gating** 是代码控制的核心:LLM 在 gathering 阶段调 search_attractions,会被 `policy.ts` 拒绝并回传 rejection prompt,LLM 不会越界。

### 3.3 Agent Loop 主循环(伪代码)

```ts
async function runAgentLoop(
  ctx: ConversationContext,
  userMessage: string,
  emit: SSEEmitter,
): Promise<ConversationContext> {
  const state = ctx.agentState;
  const messages = ctx.messages;
  messages.push({ role: "user", content: userMessage });

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    state.iteration = iter;
    const registry = buildRegistryForPhase(state.phase);
    const model = pickModel(state.phase);

    trace("llm_request", { iter, phase: state.phase, model, toolCount: registry.size() });

    const response = await callLLM({
      model,
      messages,
      tools: registry.getToolDefs(),
      systemPrompt: buildSystemPrompt(state),
      temperature: pickTemperature(state.phase),
      maxTokens: pickMaxTokens(state.phase),
    });

    trace("llm_response", {
      iter,
      stopReason: response.stopReason,
      toolCalls: response.toolCalls.map(tc => tc.name),
      thinkingExcerpt: response.text?.slice(0, 200),
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.toolCalls.length === 0) {
      if (canFinish(state, response)) {
        return finalize(ctx, response, emit);
      }
      messages.push({ role: "user", content: forceContinuePrompt(state) });
      continue;
    }

    const validation = validateToolCalls(response.toolCalls, state, registry);
    if (validation.rejected.length > 0) {
      messages.push({ role: "user", content: rejectionPrompt(validation.rejected) });
      continue;
    }

    const results = await executeToolsParallel(validation.approved, state, emit);
    messages.push({ role: "user", content: results.map(toToolResultBlock) });

    state = applyToolEffects(state, results);
    state = maybeAdvancePhase(state);

    if (state.phase === "completed") {
      return finalize(ctx, null, emit);
    }
  }

  throw new AgentLoopOverflowError(state);
}
```

### 3.4 模型分层(两级)

```ts
function pickModel(phase: Phase): string {
  switch (phase) {
    case "gathering":    return settings.LLM_LIGHT_MODEL; // 抽取 + 提问
    case "searching":    return settings.LLM_LIGHT_MODEL; // 工具选择
    case "selecting":    return settings.LLM_LIGHT_MODEL; // 选项解释
    case "planning":     return settings.LLM_MODEL;       // 行程编排(重)
    case "completed":    return settings.LLM_LIGHT_MODEL; // 收尾
  }
}
```

**默认小模型,只在 planning 用大模型。** 速度/成本最优。

### 3.5 并行工具调用

Anthropic API 原生支持单次 response 返回多个 tool_use 块。Loop 直接 `Promise.allSettled` 执行:

```ts
async function executeToolsParallel(
  calls: ToolCall[],
  state: AgentState,
  emit: SSEEmitter,
): Promise<ToolResult[]> {
  const 独立 = calls; // 同一 phase 内的工具相互独立(已在 policy.ts 校验)
  const settled = await Promise.allSettled(
    独立.map(call => registry.execute(call.name, call.input, { state, emit }))
  );
  return settled.map((s, i) =>
    s.status === "fulfilled" ? s.value : toolError(calls[i], s.reason)
  );
}
```

**鼓励 LLM 并行**:system prompt 加 hint。
```text
当需要检索多个独立信息源(景点/酒店/小红书),请一次性并行调用所有相关工具,
而不是逐个调用。这样能显著缩短响应时间。
```

---

## 4. 关键设计决策

### 4.1 代码控制 vs LLM 自主的边界

| 决策点 | 代码控制 | LLM 自主 |
|--------|---------|---------|
| Phase 转换 | ✅ 硬条件 | ❌ |
| 工具可用集 | ✅ phase gating | ❌ |
| 工具调用合法性 | ✅ schema + 状态校验 | ❌ |
| 工具调用选择 | ❌ | ✅ |
| 检索 query 构造 | ❌ | ✅ |
| 行程编排顺序 | ❌ | ✅ |
| JSON 结构 | ❌ | ✅(代码 repair) |

**简单原则**:**安全/正确性相关 → 代码;创造性相关 → LLM**。

### 4.2 JSON 鲁棒(三层防御)

```ts
// 第 1 道:提取最外层 {...}
const match = raw.match(/\{[\s\S]*\}/);

// 第 2 道:直接 JSON.parse
try { return schema.parse(JSON.parse(match[0])); }

// 第 3 道:jsonrepair(成熟库,处理尾逗号/缺括号/单引号)
import { jsonrepair } from "jsonrepair";
const repaired = jsonrepair(match[0]);
return schema.parse(JSON.parse(repaired));
```

依赖:`npm i jsonrepair`(单文件无依赖,~5KB)。

**配套**:`finalize_plan` 工具的输出走 Zod schema 校验,失败则回传 `parse_error` + 原文 excerpt,LLM 自修复。

### 4.3 信息源 rerank

每个工具有 baseWeight(可信度):

```ts
const SOURCE_WEIGHTS = {
  baike: 0.95,         // 百科权威
  official_poi: 0.85,  // 高德 POI
  hotel_provider: 0.80,// Booking
  xhs: 0.65,           // 真实但噪音多
  web_search: 0.45,    // 兜底
  llm_generated: 0.30, // LLM 兜底
};
```

聚合公式:
```
finalScore = baseRelevance * sourceWeight
           + interestMatch * 0.25
           + specificityBoost * 0.10
           - redundancyPenalty
```

`interestMatch`:用户 interests 关键词匹配。
`specificityBoost`:名称长度 + 类别具体度。
`redundancyPenalty`:已选过/已添加的重复项降权。

### 4.4 数据飞轮

```
data/feedback/
├── sessions/{sid}.json     # 完整 trace + 用户评分
├── llm-self-eval.jsonl     # LLM 自评打分
└── patterns-{YYYY-MM}.md   # 月度失败模式聚类(脚本生成)
```

**收集路径**:
1. 每次会话 finalize 后,自动 POST `/api/feedback` 存 trace
2. chat.html 加 1-5 星按钮 → POST `/api/feedback/:sid/rate`
3. finalize 后另一次 LLM 调用(plan-self-eval-prompt),打分 1-5

**复盘脚本** `scripts/review-feedback.ts`:
- 扫描评分 ≤ 2 的 case
- 提取失败模式(超时 / JSON 失败 / 工具不足 / 预算超 / 用户中断)
- 输出 `patterns-{month}.md`,作为下一轮 prompt 优化输入

### 4.5 可观测性 trace 格式

```jsonl
{"ts":"2026-06-16T10:00:01Z","sid":"abc","iter":0,"type":"llm_request","phase":"gathering","model":"glm-4.7","tools":["collect_preferences"]}
{"ts":"...","iter":0,"type":"llm_response","stop_reason":"tool_use","tool_calls":[{"name":"collect_preferences","input":{...}}],"thinking":"用户说了预算但没说目的地,先调 collect_preferences 触发弹窗"}
{"ts":"...","iter":0,"type":"tool_exec","tool":"collect_preferences","duration_ms":1200,"requires_user_input":true}
{"ts":"...","iter":0,"type":"state_change","op":"set","field":"preferences","value_summary":"{destination:东京,...}"}
{"ts":"...","iter":0,"type":"phase_change","from":"gathering","to":"searching","reason":"basics complete"}
```

**Timeline viewer** `scripts/trace-viewer.ts`:
- 读 jsonl → 生成单文件 HTML
- 显示:iter timeline / tool 调用图 / state diff / thinking 节选
- 帮助复盘"LLM 为什么在这步调了 X 工具"

---

## 5. 实施路径

### P0 — 框架(必做,其他都依赖)

**P0-A:Agent Loop 主框架**(估 5-7 天)
- 新建 `src/runtime/agent-loop.ts`
- 新建 `src/runtime/state.ts`(AgentState 类型 + phase 转换函数)
- 新建 `src/runtime/trace.ts`(结构化 trace)
- 新建 `src/tools/policy.ts`(phase gating + 风险等级)

**P0-B:工具系统重做**(估 4-5 天)
- 把 LLMPlanAgent 内联 5 工具迁到 `tools/definitions/`
- 删除 `api/tools.ts`(死代码入口)
- 新增工具:search_baike / plan_transit / select_transport / select_hotel / finalize_plan
- schema 抽到 `tools/schemas/`

**P0-C:Loop 接入对话流**(估 3-4 天)
- 改 `TurnHandler` → 委托给 Agent Loop
- 保留 ConversationOrchestrator 作为外层(HTTP/SSE 桥)
- 删除旧 Pipeline / BudgetLoopController(LLM 通过工具自驱动规划)

### P1 — 质量

**P1-A:JSON 鲁棒**(1 天) — `jsonrepair` + finalize_plan 走 Zod

**P1-B:RAG eval 扩展**(2-3 天)
- eval set 扩到 100+ 条(LLM 合成 + 人工校验)
- 基线报告:Hit Rate / MRR / NDCG@10
- 优化记录:`docs/rag-optimization-log.md`

**P1-C:行程质量**(3-4 天)
- 每日时间线 + 市内交通(plan_transit 工具)
- 信息源 rerank(SOURCE_WEIGHTS + 公式)

### P2 — 闭环

**P2-A:可观测性**(3-4 天) — trace-viewer 脚本 + HTML timeline

**P2-B:数据飞轮**(4-5 天)
- `/api/feedback` 端点 + chat.html 评分 UI
- LLM 自评
- `review-feedback.ts` 复盘脚本

**P2-C:降级路径细化**(2 天)
- 工具级 retry / timeout / fallback 链
- LLM 视角的降级提示

### 最后 — 简历 md

`docs/resume-highlight.md`:基于已落地代码 + 真实指标,不写计划性内容。

---

## 6. 风险与权衡

### 6.1 大模型调用次数与成本

Agent Loop 比直线 Pipeline 多 2-3 倍 LLM 调用。**对策**:
- 默认小模型(gathering/searching/selecting),只 planning 用大模型
- 工具结果 rerank 时 LLM 调用走小模型
- MAX_ITERATIONS=50 硬上限

### 6.2 Phase gating 太严导致 LLM 卡死

LLM 可能在 gathering 阶段执着要调 search_attractions(被拒绝),陷入循环。**对策**:
- rejection prompt 明确告诉 LLM 当前 phase 与可用工具
- 连续 3 次同种 rejection → 自动 force_finish
- maxIterations 兜底

### 6.3 单 Loop 与 SSE 流式的兼容

Loop 每轮可能跑 30s+(含工具),SSE 连接要保持。**对策**:
- 每 5s emit heartbeat
- 工具执行前后 emit progress
- 超时阈值放宽到 10min(MAX_ITERATIONS * 单轮平均)

### 6.4 与现有 Pipeline 的迁移期共存

不能一次切完。**对策**:
- 新增 `runtime/use-agent-loop.ts` 特性开关
- 老路径(POST /api/plan)保留,Pipeline 不动
- 新路径(POST /api/chat/:sid)逐步切到 Loop
- 切换完毕再删 Pipeline(独立 PR)

### 6.5 RAG eval 扩展的样本偏差

LLM 合成 query 可能与真实用户分布不一致。**对策**:
- 合成时按主题(景点/美食/交通/住宿/综合)配额
- 上线后用真实 query 持续替换合成样本
- eval set 版本化(`eval-v1.jsonl` / `eval-v2.jsonl`)

---

## 7. 不做 / 暂缓

- **上下文管理**(Q:暂缓)— Loop 内不做摘要/压缩,history 全量传入。等真出现 token 超限再加。
- **多 Agent 协作**(Q:未提)— 单 Loop 单 Agent,不引入 multi-agent。
- **微调**(Q:未提)— 用 prompt + 工具描述工程,不上 fine-tune。

---

## 8. 验收标准

P0 完成后,以下场景必须跑通:
1. 用户说"下周去东京 5 天,预算 1.5 万" → 弹偏好弹窗 → 填完 → 自动进 searching
2. searching 阶段 LLM 并行调 ≥3 个搜索工具(baike + xhs + attractions)
3. selecting 阶段推送交通+酒店选项,用户选完进 planning
4. planning 阶段 LLM 调 finalize_plan 输出 JSON,Zod 校验通过
5. 全程 trace 写入 jsonl,trace-viewer 可看思考链
6. 评分按钮可工作,数据落 `data/feedback/`

P1 完成后,追加:
7. eval set ≥ 100 条,Hit Rate 报告产出
8. JSON 解析失败率 < 1%(基线对比)
9. 行程包含市内交通(plan_transit 调用 ≥ 1 次/天)

P2 完成后,追加:
10. `patterns-{month}.md` 自动产出
11. 简历 md 引用真实指标(非计划)

---

## 9. 下一步

请你 review 本文档。确认后我从 **P0-A**(Agent Loop 主框架)开始,产出更细的 step-by-step plan,然后执行。

review 时建议重点看:
- §3.1 AgentState 字段是否齐全(漏的会导致返工)
- §3.2 工具 phase 矩阵是否合理(影响 LLM 行为)
- §4.1 代码控制 vs LLM 自主的边界划分
- §6 风险是否有遗漏
