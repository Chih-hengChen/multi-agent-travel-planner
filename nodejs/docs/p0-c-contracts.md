# P0-C 接口契约

> 关联:`docs/agent-loop-redesign.md` §5 P0-C / §2.1 数据流
> 立项:2026-06-18
> 状态:**Hard contract** — P0-C 实现期不允许偏离,变更需更新本文档 + 重跑测试
> 目的:把 Agent Loop 接入对话流的接口、删除范围、SSE 事件映射全部锁定

---

## 0. 文档定位

P0-A 完成了 Agent Loop 主框架,P0-B 完成了工具系统重做。P0-C 把两者接入实际对话流:

- `TurnHandler.handleMessage()` 从旧状态机+管线 → 委托 `runAgentLoop()`
- `ConversationOrchestrator` 保留,作为 HTTP/SSE 桥
- 删除旧 `TravelPlanningPipeline` + `BudgetLoopController`

---

## 1. 接入点:TurnHandler → Agent Loop

### 1.1 当前流程(旧)

```
TurnHandler.handleMessage
  → IntentRouter.route()
  → 状态机分支(INIT/GATHERING/SEARCHING/...共 11 状态)
  → TravelPlanningPipeline.run()
    → PipelineExecutor(并行 Flight/Hotel/Activity)
    → BudgetLoopController(预算循环)
  → 返回 TurnResult(消息 + PlanSummary)
```

### 1.2 目标流程(新)

```
TurnHandler.handleMessage
  → IntentRouter.route()(可选,保留)
  → runAgentLoop(ctx, userMessage, emit)
    → 内部:phase gating → LLM 决策 → 工具执行 → state 转换
  → 返回 ctx(含 AgentState + messages)
```

### 1.3 TurnHandler 接口变更

```ts
// 旧接口(删除)
interface TurnResult {
  messages: AgentMessage[];
  summary?: PlanSummary;
  state: ConversationState;
  transportOptions?: TransportOption[];
  hotelOptions?: Hotel[];
}

// 新接口(P0-C 后)
interface TurnResult {
  ctx: ConversationContext;
  done: boolean;
}
```

### 1.4 handleMessage 签名

```ts
async handleMessage(sessionId: string, userMessage: string): Promise<TurnResult> {
  const ctx = await this.loadContext(sessionId);

  const route = this.intentRouter?.route(userMessage);
  if (route && route.intent !== "travel_planning") {
    return this.handleNonTravel(ctx, route);
  }

  const signals: SSEEvent[] = [];
  const emit: SSEEmitter = (event) => signals.push(event);

  const updated = await runAgentLoop(ctx, userMessage, emit);

  await this.saveContext(sessionId, updated);

  return { ctx: updated, done: updated.agentState.phase === "completed", signals };
}
```

---

## 2. ConversationOrchestrator 保留

### 2.1 保留职责

| 职责 | 说明 |
|------|------|
| Session 生命周期 | `createSession()` / `getSession()` / `deleteSession()` |
| HTTP/SSE 桥 | `handleMessage()` 返回 SSE 流,`handleSelect()` 处理选择 |
| 持久化 | 调用 `SessionStore.set()` 保存 `ConversationContext` |
| 日志 | `sessionLogger` 写 session 事件 |

### 2.2 适配变更

```ts
async handleMessage(sessionId: string, userMessage: string): Promise<SSEStream> {
  const ctx = await this.sessionStore.get(sessionId);
  const emitter = new SSEEmitter();

  emitter.onEvent = (event) => {
    this.res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
  };

  const result = await this.turnHandler.handleMessage(sessionId, userMessage, emitter);

  await this.sessionStore.set(sessionId, result.ctx);
  return emitter;
}
```

### 2.3 ConversationContext 扩展

```ts
interface ConversationContext {
  // ... 现有字段(sessionId, state, messages 等)
  agentState: AgentState;       // 新增:P0-A 的 AgentState
  messageHistory: Message[];    // 新增:LLM 全量对话历史
}
```

迁移时从旧的 `state: ConversationState` 映射到 `agentState.phase`,旧 `selectedTransport / selectedHotel` 映射到 agentState 对应字段。

---

## 3. 删除清单

### 3.1 TravelPlanningPipeline

文件:`src/orchestrator/pipeline.ts`
删除原因:Agent Loop 通过 LLM 自主决策替代硬编码顺序;`finalize_plan` 工具替代 `plan_travel` 工具。

### 3.2 BudgetLoopController

文件:`src/orchestrator/budget-loop.ts`
删除原因:预算循环逻辑内化到 Agent Loop 的 `applyFinalizePlan`,`budgetRound` 由 `AgentState` 控制。

### 3.3 PipelineExecutor + parallel.ts

文件:`src/orchestrator/parallel.ts`
删除原因:并行工具执行由 Agent Loop 的 `executeToolsParallel` 处理。

### 3.4 Agent 去留表

| 文件 | 操作 | 原因 |
|------|------|------|
| `agents/flight-agent.ts` | **保留**(暂) | 交通搜索逻辑待提取到工具 |
| `agents/hotel-agent.ts` | **保留**(暂) | 酒店逻辑待完全迁移 |
| `agents/activity-agent.ts` | **删除** | 被 `finalize_plan` 取代 |
| `agents/budget-agent.ts` | **删除** | 被 `applyFinalizePlan` 取代 |
| `agents/gathering-agent.ts` | **删除** | 被 Agent Loop gathering phase 取代 |
| `agents/preference-agent.ts` | **删除** | 被 `collect_preferences` 工具取代 |
| `agents/destination-agent.ts` | **删除** | 已降级为纯函数 |
| `agents/base-agent.ts` | **删除** | 不再需要 Agent 基类 |

---

## 4. SSE 事件映射

### 4.1 事件类型

```ts
type SSEEventType =
  | "progress"     // 工具执行进度
  | "options"      // 交通/酒店候选
  | "partial"      // 行程片段
  | "phase_change" // phase 转换
  | "done"         // 完成
  | "error";       // 错误
```

### 4.2 事件结构

```ts
// progress
{ type:"progress", data:{ phase, iteration, tool, status, message } }

// options
{ type:"options", data:{ transports?, hotels?, restaurants? } }

// partial
{ type:"partial", data:{ dayIdx, content } }

// phase_change
{ type:"phase_change", data:{ from, to, reason } }

// done
{ type:"done", data:{ plan:TravelPlan, breakdown:BudgetBreakdown } }
```

### 4.3 与旧格式兼容

前端 `chat.html` 需要适配新的 SSE 事件类型,或通过适配层转换。旧格式保留向后兼容。

---

## 5. 测试计划

| 测试项 | 覆盖 |
|--------|------|
| TurnHandler 委托 | handleMessage 正确调用 runAgentLoop 并传参 |
| SSE 事件映射 | 5 类事件正确 emit 到 ConversationOrchestrator |
| Context 序列化 | AgentState 完整 JSON 序列化/反序列化(SessionStore) |
| E2E 对话流 | "帮我规划东京 5 天旅行" 全流程走通 |

---

## 6. P0-C 文件级 step plan

**Step 1**: `ConversationContext` 加 `agentState` + `messages` 字段 → commit:`feat(context): add AgentState to ConversationContext`

**Step 2**: `runtime/sse.ts`(新建) SSE 事件系统 → commit:`feat(runtime): SSE event system for Agent Loop`

**Step 3**: `turn-handler.ts` 改造,handleMessage 委托 Agent Loop → commit:`refactor(conversation): TurnHandler delegates to Agent Loop`

**Step 4**: 删除旧 Pipeline + BudgetLoop + 废弃 Agents(6+ 文件) → commit:`refactor: remove old Pipeline and deprecated agents`

**Step 5**: E2E 集成测试 → commit:`test: P0-C end-to-end conversation flow`

**P0-C 总估时**:3-4 天

---

## 7. P0-C 启动检查清单

- [ ] Agent Loop 可独立运行(mock LLM 验证 phase 转换)
- [ ] 所有 12 工具已在 ToolRegistry 注册
- [ ] ConversationContext 与 AgentState 字段映射表已对齐
- [ ] SSE 事件格式与前端 `chat.html` 兼容或已适配
- [ ] SessionStore 可序列化 AgentState

---

## 8. 关联文档

| 文档 | 内容 |
|------|------|
| `docs/agent-loop-redesign.md` §2.1 / §5 | 数据流 + P0-C 任务描述 |
| `docs/p0-a-contracts.md` | Agent Loop 5 核心函数契约 |
| `docs/p0-b-contracts.md` | 12 工具系统契约 |
| `nodejs/src/runtime/agent-loop.ts` | Agent Loop 主循环 |
| `nodejs/src/conversation/turn-handler.ts` | 当前 TurnHandler(改造目标) |
