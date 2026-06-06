import type { Logger } from "pino";
import pino from "pino";
import type { AgentStep, StepInput, StepOutput, StepRecord, StepStatus } from "./types.js";
import type { ErrorType } from "../conversation/state-machine.js";
import { settings } from "../config/settings.js";
import { withSessionId, getSessionId } from "../logging/session-context.js";
import { sessionLogger } from "../logging/session-logger.js";

function defaultValidate(_output: StepOutput): { valid: boolean; errors: string[] } {
  return { valid: true, errors: [] };
}

function classifyError(err: unknown): { message: string; type: ErrorType } {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("timeout") || msg.includes("timed out")) {
    return { message: msg, type: "tool_timeout" as ErrorType };
  }
  if (msg.includes("auth") || msg.includes("unauthorized") || msg.includes("401")) {
    return { message: msg, type: "tool_auth_error" as ErrorType };
  }
  if (msg.includes("rate") || msg.includes("429")) {
    return { message: msg, type: "tool_rate_limit" as ErrorType };
  }
  if (msg.includes("empty") || msg.includes("not found") || msg.includes("no results")) {
    return { message: msg, type: "tool_empty_result" as ErrorType };
  }
  return { message: msg, type: "validation_error" as ErrorType };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class StepExecutor {
  private readonly log: Logger;

  constructor(log?: Logger) {
    this.log = log ?? pino({ level: settings.LOG_LEVEL });
  }

  async run(
    step: AgentStep,
    input: StepInput,
    sessionId?: string,
    onStatus?: (record: StepRecord) => void,
  ): Promise<StepRecord> {
    const sid = sessionId ?? getSessionId() ?? "unknown";
    return withSessionId(sid, async () => {
      const record: StepRecord = {
        stepId: step.id,
        stepName: step.name,
        status: "pending",
        retryCount: 0,
      };

      const updateStatus = (status: StepStatus, extra?: Partial<StepRecord>) => {
        record.status = status;
        if (extra) Object.assign(record, extra);
        sessionLogger.append(sid, "step_status", { ...record });
        onStatus?.({ ...record });
      };

      updateStatus("running", { input, startedAt: Date.now() });

      let lastError: { message: string; type: ErrorType } | null = null;
      let output: StepOutput | null = null;
      let succeeded = false;

      for (let attempt = 0; attempt <= step.retryPolicy.maxRetries; attempt++) {
        if (attempt > 0) {
          updateStatus("retrying", { retryCount: attempt });
          const delay = step.retryPolicy.backoffMs * Math.pow(step.retryPolicy.backoffMultiplier, attempt - 1);
          await sleep(delay);
        }

        try {
          output = await Promise.race([
            step.execute(attempt > 0 ? { ...input, _retryAttempt: attempt } : input),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`Step ${step.name} timed out after ${step.timeoutMs}ms`)), step.timeoutMs),
            ),
          ]);
          succeeded = true;
          break;
        } catch (err) {
          lastError = classifyError(err);
          record.error = lastError.message;
          record.errorType = lastError.type;
          this.log.warn({ step: step.name, attempt, error: lastError }, "Step attempt failed");
        }
      }

      if (!succeeded) {
        updateStatus("failed", { error: lastError?.message, errorType: lastError?.type, completedAt: Date.now() });
        return { ...record };
      }

      updateStatus("validating", { output: output ?? undefined });
      const validation = step.validate
        ? step.validate(output!)
        : defaultValidate(output!);

      if (!validation.valid) {
        record.error = validation.errors.join("; ");
        record.errorType = "validation_error";

        updateStatus("failed", { error: record.error, errorType: "validation_error", completedAt: Date.now() });
        return { ...record };
      }

      updateStatus("succeeded", { output: output ?? undefined, completedAt: Date.now() });
      return { ...record };
    });
  }
}

export type { AgentStep, StepRecord, StepInput, StepOutput } from "./types.js";
