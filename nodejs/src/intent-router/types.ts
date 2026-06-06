export type Intent =
  | "simple_answer"
  | "slot_filling"
  | "deterministic_workflow"
  | "multi_agent_planning"
  | "human_confirmation"
  | "unsupported";

export type ExecutionMode =
  | "simple_llm"
  | "workflow"
  | "multi_agent"
  | "human_confirm";

export interface RouteDecision {
  intent: Intent;
  executionMode: ExecutionMode;
  confidence: number;
  reason: string;
  requiredFields: string[];
  humanCheckpoints: string[];
}
