import crypto from "node:crypto";
import { sessionLogger } from "../logging/session-logger.js";
import type { RouteDecision } from "../intent-router/types.js";
import type { ConversationState } from "../conversation/state-machine.js";

export type TraceActor =
  | "user"
  | "router"
  | "llm"
  | "agent"
  | "tool"
  | "source"
  | "validator"
  | "recovery";

export interface TraceEvent {
  traceId: string;
  sessionId: string;
  stepId: string;
  parentStepId?: string;
  timestamp: string;
  actor: TraceActor;
  action: string;
  stateBefore?: string;
  stateAfter?: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  latencyMs?: number;
  decisionReason?: string;
}

export class TraceRecorder {
  record(event: Omit<TraceEvent, "traceId" | "timestamp">): TraceEvent {
    const trace: TraceEvent = {
      traceId: crypto.randomUUID().slice(0, 8),
      timestamp: new Date().toISOString(),
      ...event,
    };

    sessionLogger.append(event.sessionId, "trace_event", trace);
    return trace;
  }

  routeDecision(sessionId: string, decision: RouteDecision, stateBefore?: string): TraceEvent {
    return this.record({
      sessionId,
      stepId: "router",
      actor: "router",
      action: "route_decision",
      stateBefore,
      decisionReason: decision.reason,
      input: { intent: decision.intent, executionMode: decision.executionMode },
      output: decision,
    });
  }

  stateTransition(
    sessionId: string,
    from: ConversationState,
    to: ConversationState,
    reason?: string,
  ): TraceEvent {
    return this.record({
      sessionId,
      stepId: "state_machine",
      actor: "router",
      action: "state_transition",
      stateBefore: from,
      stateAfter: to,
      decisionReason: reason,
    });
  }

  toolCall(
    sessionId: string,
    toolName: string,
    input: unknown,
    output: unknown,
    latencyMs: number,
    error?: unknown,
  ): TraceEvent {
    return this.record({
      sessionId,
      stepId: `tool:${toolName}`,
      actor: "tool",
      action: `tool_call:${toolName}`,
      input,
      output,
      error,
      latencyMs,
    });
  }

  llmInteraction(
    sessionId: string,
    caller: string,
    input: unknown,
    output: unknown,
    latencyMs: number,
  ): TraceEvent {
    return this.record({
      sessionId,
      stepId: `llm:${caller}`,
      actor: "llm",
      action: `llm_call:${caller}`,
      input,
      output,
      latencyMs,
    });
  }

  recoveryAction(
    sessionId: string,
    errorType: string,
    action: string,
    stateBefore: string,
    stateAfter?: string,
  ): TraceEvent {
    return this.record({
      sessionId,
      stepId: "recovery",
      actor: "recovery",
      action: `recovery:${action}`,
      error: errorType,
      stateBefore,
      stateAfter,
    });
  }
}

export const traceRecorder = new TraceRecorder();
