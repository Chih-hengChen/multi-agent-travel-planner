import type { Message, ContentBlock, ToolDef } from "../api/llm-client.js";
import { settings } from "../config/settings.js";
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
import { buildSystemPrompt, stateSummary } from "./system-prompt.js";
export { stateSummary, buildSystemPrompt } from "./system-prompt.js";
import { listToolsForPhase, isToolAllowedInPhase } from "../tools/policy.js";

export const MAX_ITERATIONS = 30;
export const MAX_STALE_ITERS = 10;
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
  toolDefs?: ToolDef[];
}

export interface LoopResult {
  state: AgentState;
  messages: Message[];
  iterations: number;
  forceStopped?: boolean;
  reason?: string;
  pausedForSelection?: boolean;
}

interface ExecutedTool {
  call: ToolCall;
  result: ToolResultLike;
  durationMs: number;
}

export function pickModel(phase: Phase): string {
  switch (phase) {
    case "planning":  return settings.LLM_MODEL;
    default:          return settings.LLM_LIGHT_MODEL;
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
  let staleCount = 0;

  let consecutiveRejections = 0;
  let jsonRepairAttempts = 0;
  const MAX_JSON_REPAIR = 3;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    state = { ...state, iteration: iter };

    if (state._pendingBudgetFeedback) {
      messages.push({ role: "user", content: state._pendingBudgetFeedback });
      state = { ...state, _pendingBudgetFeedback: undefined };
    }

    const tools = deps.toolDefs && deps.toolDefs.length > 0
      ? deps.toolDefs.filter(t => isToolAllowedInPhase(t.name, state.phase))
      : toToolDefs(state.phase);
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
      if (state.phase === "selecting") {
        return { state, messages, iterations: iter + 1, pausedForSelection: true };
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

    // JSON self-repair: finalize_plan JSON 解析失败时,回传 LLM 修复
    const jsonRepair = executed.find(e => !e.result.success && e.result._jsonRepairError === true);
    if (jsonRepair) {
      jsonRepairAttempts++;
      if (jsonRepairAttempts >= MAX_JSON_REPAIR) {
        throw new Error(`JSON 自修复耗尽(${MAX_JSON_REPAIR}次):${jsonRepair.result.error}`);
      }
      messages.push({
        role: "user",
        content: `JSON 解析失败(第 ${jsonRepairAttempts} 次):${jsonRepair.result.error}

请修正以上 JSON 错误后重新输出完整 finalize_plan JSON。
常见错误:尾逗号 / 缺括号 / 单引号代替双引号 / key 没有加引号。`,
      });
      continue;
    }

    state = applyToolEffects(state, executed.map(e => e.result));
    const prevPhase = state.phase;
    state = maybeAdvancePhase(state);

    if (state.phase === prevPhase) {
      staleCount++;
      if (staleCount >= MAX_STALE_ITERS) {
        const phaseDescs: Record<Phase, string> = {
          gathering: "偏好未收集完整,工具返回空",
          searching: "检索工具均返回空数据,candidateTransports/candidateHotels 为空",
          selecting: "选择工具未设置 selectedOutbound/selectedHotel",
          planning: "行程编排未完成(dayPlans 与旅行天数不匹配或未通过质量检查)",
          completed: "已完成",
        };
        const reason = phaseDescs[state.phase] ?? `卡在 ${state.phase} 阶段 ${staleCount} 轮无推进`;
        deps.emit?.emit({ type: "stale_abort", iter, phase: state.phase, staleCount, reason });
        return { state, messages, iterations: iter + 1, forceStopped: true, reason };
      }
    } else {
      staleCount = 0;
    }

    if (canFinish(state)) {
      return { state, messages, iterations: iter + 1 };
    }
  }

  throw new AgentLoopOverflowError(state);
}
