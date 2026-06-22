export {
  type AgentState,
  type Phase,
  type TransitSegment,
  type PlanDayPlan,
  type BudgetBreakdownV2,
  type WeatherSummary,
  type XhsNote,
  type UserSelection,
  createInitialAgentState,
  computeTravelDays,
  isPreferencesComplete,
  applyUserSelection,
  maybeAdvancePhase,
  canFinish,
  getMissingRequirements,
  MAX_BUDGET_ROUNDS,
} from "./state.js";

export {
  runAgentLoop,
  pickModel,
  pickTemperature,
  pickMaxTokens,
  forceContinuePrompt,
  rejectionPrompt,
  MAX_ITERATIONS,
  MAX_REJECTIONS_PER_ITER,
  AgentLoopOverflowError,
  RejectionLoopError,
  type LLMCaller,
  type LLMResponse,
  type LLMCallOptions,
  type LLMToolCall,
  type ToolExecutor,
  type LoopDeps,
  type LoopResult,
  type SSEEmitter,
  type SSEEvent,
} from "./agent-loop.js";

export {
  buildSystemPrompt,
  stateSummary,
} from "./system-prompt.js";

export {
  traceNow,
  parseThought,
  setTraceDir,
  getTraceDir,
  type TraceEvent,
} from "./trace.js";

export {
  validateToolCalls,
  stableHash,
  type ToolCall,
  type ValidationCode,
  type RejectedCall,
  type ValidationResult,
  type SchemaLookup,
} from "./validate-tool-calls.js";

export {
  applyToolEffects,
  applyFinalizePlan,
  type ToolResultLike,
  type StateReducer,
} from "./apply-tool-effects.js";

export {
  createSSEBridge,
  type ForwardingSSEEmitter,
} from "./sse.js";
