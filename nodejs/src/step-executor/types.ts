import type { RecoveryPolicy, ErrorType } from "../conversation/state-machine.js";

export type StepStatus =
  | "pending"
  | "running"
  | "validating"
  | "succeeded"
  | "failed"
  | "recovering"
  | "retrying"
  | "degraded"
  | "needs_user"
  | "terminal";

export interface RetryPolicy {
  maxRetries: number;
  backoffMs: number;
  backoffMultiplier: number;
}

export interface StepInput {
  [key: string]: unknown;
}

export interface StepOutput {
  [key: string]: unknown;
}

export interface AgentStep {
  id: string;
  name: string;
  execute: (input: StepInput) => Promise<StepOutput>;
  validate: (output: StepOutput) => { valid: boolean; errors: string[] };
  timeoutMs: number;
  retryPolicy: RetryPolicy;
  recoveryPolicy: RecoveryPolicy;
}

export interface StepRecord {
  stepId: string;
  stepName: string;
  status: StepStatus;
  input?: StepInput;
  output?: StepOutput;
  error?: string;
  errorType?: ErrorType;
  startedAt?: number;
  completedAt?: number;
  retryCount: number;
  recoveryAction?: string;
}
