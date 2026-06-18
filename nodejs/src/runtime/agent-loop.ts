import type { Message, ContentBlock, ToolDef } from "../api/llm-client.js";
import {
  type AgentState,
  type Phase,
  canFinish,
  maybeAdvancePhase,
} from "./state.js";
import { traceNow, parseThought } from "./trace.js";
import {
  type ToolCall,
  type RejectedCall,
  type SchemaLookup,
  validateToolCalls,
} from "./validate-tool-calls.js";
import { applyToolEffects, type ToolResultLike } from "./apply-tool-effects.js";
import { listToolsForPhase } from "../tools/policy.js";

export const MAX_ITERATIONS = 50;
export const MAX_REJECTIONS_PER_ITER = 3;

export class AgentLoopOverflowError extends Error {
  constructor(public readonly finalState: AgentState) {
    super(`Agent loop exceeded ${MAX_ITERATIONS} iterations`);
    this.name = "AgentLoopOverflowError";
  }
}

export class RejectionLoopError extends Error {
  constructor(public readonly finalState: AgentState, public readonly lastRejections: RejectedCall[]) {
    super(`Agent loop stuck: ${MAX_REJECTIONS_PER_ITER} consecutive rejections`);
    this.name = "RejectionLoopError";
  }
}

export interface LLMToolCall {
  id?: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LLMResponse {
  stopReason: string;
  text: string;
  toolCalls: LLMToolCall[];
}

export interface LLMCallOptions {
  model: string;
  messages: Message[];
  tools: ToolDef[];
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
}

export interface LLMCaller {
  call(opts: LLMCallOptions): Promise<LLMResponse>;
}

export interface ToolExecutor {
  execute(call: ToolCall, state: AgentState): Promise<ToolResultLike>;
}

export interface SSEEvent {
  type: string;
  [key: string]: unknown;
}

export interface SSEEmitter {
  emit(event: SSEEvent): void;
}

export interface LoopDeps {
  llmCaller: LLMCaller;
  schemaLookup: SchemaLookup;
  toolExecutor: ToolExecutor;
  emit?: SSEEmitter;
}

export interface LoopResult {
  state: AgentState;
  messages: Message[];
  iterations: number;
}

interface ExecutedTool {
  call: ToolCall;
  result: ToolResultLike;
  durationMs: number;
}

export function pickModel(phase: Phase): string {
  switch (phase) {
    case "planning":  return "heavy-llm";
    default:          return "light-llm";
  }
}

export function pickTemperature(phase: Phase): number {
  switch (phase) {
    case "gathering": return 0.4;
    case "searching": return 0.4;
    case "selecting": return 0.1;
    case "planning":  return 0.7;
    case "completed": return 0.4;
  }
}

export function pickMaxTokens(phase: Phase): number {
  switch (phase) {
    case "planning":  return 8192;
    default:          return 4096;
  }
}

const BASE_PROMPT = `你是一个旅行规划 Agent,通过工具调用完成多阶段任务。

【ReAct 推理要求】
在每次决策前,你必须先用 <thought>...</thought> 块输出推理,内容包括:
1. 当前 phase 与已有信息(1 句)
2. 下一步要做什么、为什么(1-2 句)
3. 拟调用的工具与关键参数

示例:
<thought>
phase=searching, 已有目的地东京。下一步需要并行获取景点/酒店/小红书真实评价。
</thought>

【并行调用】
当需要检索多个独立信息源(景点/酒店/小红书/百科),请一次性并行调用所有相关工具,而非逐个。

【JSON 输出】
finalize_plan 工具的 rawJson 字段必须是合法 JSON,不要省略花括号或逗号。

【约束】
- 不要在 gathering 阶段调用 search_*
- 不要在 planning 阶段调用 collect_preferences
- 同一轮内不要用相同参数重复调用同一工具`;

const PHASE_PROMPTS: Record<Phase, string> = {
  gathering:  `【当前阶段:gathering(收集偏好)】
任务:通过 collect_preferences 工具获取用户的 destination / departureCity / startDate / endDate / numTravelers / budget。
下一阶段:必填字段齐全 → searching(自动)。`,

  searching:  `【当前阶段:searching(并行检索)】
任务:并行调用 search_baike / search_attractions / search_hotels / search_xhs / search_restaurants(scope=city)。
约束:
- 高德 API 全局限流 3 QPS(代码层排队)
- search_xhs 默认 30 篇,不够再爬 30
- search_restaurants 用 scope=city(城市热门),不要 scope=attraction
下一阶段:候选齐全 → selecting。`,

  selecting:  `【当前阶段:selecting(用户选择)】
任务:推送交通候选(去程+返程)和酒店候选,等待用户用 select_transport / select_hotel 工具确认。
下一阶段:三个 selected 字段齐全 → planning。`,

  planning:   `【当前阶段:planning(行程编排)】
任务:为每一天编排景点 + 衔接交通 + 餐厅。最后调 finalize_plan 输出完整 JSON。
约束:
- 景点→景点之间用 plan_transit 工具
- search_restaurants 用 scope=attraction + near=<景点名>
- 餐厅多样性:本地特色 ≤60%、排除连锁(除非用户显式)
- finalize_plan 失败 → planning,budgetRound+1,最多重试 3 次`,

  completed:  `【当前阶段:completed】
行程已交付,等待用户反馈或新指令。`,
};

export function stateSummary(state: AgentState): string {
  const lines: string[] = [];
  if (state.preferences) {
    const p = state.preferences;
    lines.push(`目的地:${p.preferredDestination ?? "(待填)"}, 出发地:${p.departureCity ?? "(待填)"}`);
    lines.push(`日期:${p.startDate ?? "?"} ~ ${p.endDate ?? "?"}, 人数:${p.numTravelers ?? "?"}, 预算:¥${p.budget ?? "?"}`);
  }
  if (state.baikeKnowledge) lines.push(`百科:已知`);
  if (state.candidateAttractions?.length) lines.push(`候选景点:${state.candidateAttractions.length} 个`);
  if (state.candidateHotels?.length) lines.push(`候选酒店:${state.candidateHotels.length} 家`);
  if (state.candidateRestaurants?.length) lines.push(`候选餐厅(城市级):${state.candidateRestaurants.length} 家`);
  if (state.xhsNotes?.length) lines.push(`XHS 笔记:${state.xhsNotes.length} 篇`);
  if (state.selectedOutbound) lines.push(`已选去程:${(state.selectedOutbound as { flightNo?: string; trainNo?: string }).flightNo ?? (state.selectedOutbound as { trainNo?: string }).trainNo ?? "?"}`);
  if (state.selectedReturn) lines.push(`已选返程:${(state.selectedReturn as { flightNo?: string; trainNo?: string }).flightNo ?? (state.selectedReturn as { trainNo?: string }).trainNo ?? "?"}`);
  if (state.selectedHotel) lines.push(`已选酒店:${(state.selectedHotel as { name?: string }).name ?? "?"}`);
  if (state.dayPlans?.length) lines.push(`已编排:${state.dayPlans.length} 天`);
  if (state.budgetBreakdown) lines.push(`预算:${state.budgetBreakdown.totalCost}/${state.budgetBreakdown.budgetLimit}(${state.budgetBreakdown.isWithinBudget ? "内" : "超"})`);
  if (state.budgetRound > 0) lines.push(`budgetRound:${state.budgetRound}`);
  if (state.errorMessages.length) lines.push(`错误:${state.errorMessages.length} 条`);
  return lines.join("\n") || "(state 为空)";
}

export function buildSystemPrompt(state: AgentState): string {
  const tools = listToolsForPhase(state.phase);
  return [
    BASE_PROMPT, "",
    PHASE_PROMPTS[state.phase], "",
    "【当前 state 摘要】",
    stateSummary(state),
    "",
    "【可用工具(本 phase)】",
    tools.length > 0
      ? tools.map(t => `- ${t.name}: ${t.description}`).join("\n")
      : "(无)",
  ].join("\n");
}

export function forceContinuePrompt(state: AgentState): string {
  return `你当前在 ${state.phase} 阶段,但尚未满足完成条件。

请直接调用工具继续,不要等待用户输入。再次提醒:必须在调用工具前用 <thought>...</thought> 说明你的推理。`;
}

export function rejectionPrompt(rejected: RejectedCall[]): string {
  const items = rejected.map(r => `- [${r.code}] ${r.call.name}: ${r.reason}`);
  return `以下工具调用被拒绝,请重新决策:

${items.join("\n")}

请调整参数或换用其他工具。`;
}

function respToAssistantContent(resp: LLMResponse): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (resp.text) {
    blocks.push({ type: "text", text: resp.text });
  }
  for (const tc of resp.toolCalls) {
    blocks.push({
      type: "tool_use",
      id: tc.id ?? tc.name,
      name: tc.name,
      input: tc.input,
    });
  }
  return blocks;
}

function executedToToolResultContent(executed: ExecutedTool[]): ContentBlock[] {
  return executed.map(({ call, result }) => ({
    type: "tool_result" as const,
    tool_use_id: call.id ?? call.name,
    content: JSON.stringify(result.success ? result.data : { error: result.error }),
  }));
}

function toToolDefs(phase: Phase): ToolDef[] {
  return listToolsForPhase(phase).map(t => ({
    name: t.name,
    description: t.description,
    input_schema: {},
  }));
}

async function executeToolsParallel(
  calls: ToolCall[],
  state: AgentState,
  executor: ToolExecutor,
): Promise<ExecutedTool[]> {
  const settled = await Promise.allSettled(
    calls.map(call => executor.execute(call, state)),
  );
  return settled.map((s, i) => {
    const call = calls[i];
    if (s.status === "fulfilled") {
      return { call, result: s.value, durationMs: 0 };
    }
    return {
      call,
      result: {
        toolName: call.name,
        success: false,
        error: s.reason instanceof Error ? s.reason.message : String(s.reason),
      } as ToolResultLike,
      durationMs: 0,
    };
  });
}

export async function runAgentLoop(
  sid: string,
  initialState: AgentState,
  initialMessages: Message[],
  userMessage: string,
  deps: LoopDeps,
): Promise<LoopResult> {
  let state: AgentState = { ...initialState };
  const messages: Message[] = [
    ...initialMessages,
    { role: "user", content: userMessage },
  ];

  let consecutiveRejections = 0;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    state = { ...state, iteration: iter };

    if (state._pendingBudgetFeedback) {
      messages.push({ role: "user", content: state._pendingBudgetFeedback });
      state = { ...state, _pendingBudgetFeedback: undefined };
    }

    const tools = toToolDefs(state.phase);
    const model = pickModel(state.phase);

    traceNow(sid, iter, {
      type: "llm_request",
      phase: state.phase,
      model,
      tools: tools.map(t => t.name),
    });
    deps.emit?.emit({ type: "llm_request", iter, phase: state.phase, model });

    const resp = await deps.llmCaller.call({
      model,
      messages,
      tools,
      systemPrompt: buildSystemPrompt(state),
      temperature: pickTemperature(state.phase),
      maxTokens: pickMaxTokens(state.phase),
    });

    const thought = parseThought(resp.text);
    state = { ...state, lastThought: thought };

    traceNow(sid, iter, {
      type: "llm_response",
      stopReason: resp.stopReason,
      thought,
      toolCalls: resp.toolCalls.map(tc => ({ name: tc.name, input: tc.input })),
      fallbackUsage: state.fallbackUsage,
    });
    deps.emit?.emit({
      type: "llm_response",
      iter,
      thought,
      stopReason: resp.stopReason,
      toolCallCount: resp.toolCalls.length,
    });

    messages.push({ role: "assistant", content: respToAssistantContent(resp) });

    if (resp.toolCalls.length === 0) {
      consecutiveRejections = 0;
      if (canFinish(state)) {
        return { state, messages, iterations: iter + 1 };
      }
      messages.push({ role: "user", content: forceContinuePrompt(state) });
      continue;
    }

    const calls: ToolCall[] = resp.toolCalls.map(tc => ({
      id: tc.id,
      name: tc.name,
      input: tc.input,
    }));
    const validation = validateToolCalls(calls, state, deps.schemaLookup);
    if (validation.rejected.length > 0) {
      consecutiveRejections++;
      if (consecutiveRejections >= MAX_REJECTIONS_PER_ITER) {
        throw new RejectionLoopError(state, validation.rejected);
      }
      messages.push({ role: "user", content: rejectionPrompt(validation.rejected) });
      continue;
    }
    consecutiveRejections = 0;

    const executed = await executeToolsParallel(validation.approved, state, deps.toolExecutor);
    for (const { call, result, durationMs } of executed) {
      traceNow(sid, iter, {
        type: "tool_exec",
        tool: call.name,
        durationMs,
        fallbackLevel: result.fallbackLevel ?? 0,
        resultSummary: result.success
          ? (result.data && typeof result.data === "object" ? Object.keys(result.data as object) : "primitive")
          : { error: result.error },
      });
    }
    deps.emit?.emit({
      type: "tools_executed",
      iter,
      count: executed.length,
      failures: executed.filter(e => !e.result.success).length,
    });

    messages.push({ role: "user", content: executedToToolResultContent(executed) });

    state = applyToolEffects(state, executed.map(e => e.result));
    state = maybeAdvancePhase(state);

    if (canFinish(state)) {
      return { state, messages, iterations: iter + 1 };
    }
  }

  throw new AgentLoopOverflowError(state);
}
