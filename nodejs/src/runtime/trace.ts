import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Phase } from "./state.js";

export type TraceEventType =
  | "llm_request"
  | "llm_response"
  | "tool_exec"
  | "state_change"
  | "phase_change"
  | "heartbeat"
  | "error";

export interface LlmRequestTraceEvent {
  ts: string;
  sid: string;
  iter: number;
  type: "llm_request";
  phase: Phase;
  model: string;
  tools: string[];
}

export interface LlmResponseTraceEvent {
  ts: string;
  sid: string;
  iter: number;
  type: "llm_response";
  stopReason: string;
  thought: string;
  toolCalls: Array<{ name: string; input?: unknown }>;
  fallbackUsage?: Record<string, number>;
}

export interface ToolExecTraceEvent {
  ts: string;
  sid: string;
  iter: number;
  type: "tool_exec";
  tool: string;
  durationMs: number;
  fallbackLevel: number;
  resultSummary?: unknown;
  amapWaitMs?: number;
}

export interface StateChangeTraceEvent {
  ts: string;
  sid: string;
  iter: number;
  type: "state_change";
  op: "set" | "append" | "merge";
  field: string;
  valueSummary?: unknown;
}

export interface PhaseChangeTraceEvent {
  ts: string;
  sid: string;
  iter: number;
  type: "phase_change";
  from: Phase;
  to: Phase;
  reason: string;
}

export interface HeartbeatTraceEvent {
  ts: string;
  sid: string;
  iter: number;
  type: "heartbeat";
  message?: string;
}

export interface ErrorTraceEvent {
  ts: string;
  sid: string;
  iter: number;
  type: "error";
  error: string;
  stack?: string;
}

export type TraceEvent =
  | LlmRequestTraceEvent
  | LlmResponseTraceEvent
  | ToolExecTraceEvent
  | StateChangeTraceEvent
  | PhaseChangeTraceEvent
  | HeartbeatTraceEvent
  | ErrorTraceEvent;

let traceDir = "data/trace";

export function setTraceDir(dir: string): void {
  traceDir = dir;
}

export function getTraceDir(): string {
  return traceDir;
}

export function traceFilePath(sid: string): string {
  return `${traceDir}/${sid}.jsonl`;
}

export function trace(event: TraceEvent): void {
  const fullPath = traceFilePath(event.sid);
  mkdirSync(dirname(fullPath), { recursive: true });
  appendFileSync(fullPath, JSON.stringify(event) + "\n", "utf8");
}

export function makeTraceEvent<E extends TraceEvent>(
  sid: string,
  iter: number,
  event: Omit<E, "ts" | "sid" | "iter">,
): E {
  return {
    ts: new Date().toISOString(),
    sid,
    iter,
    ...event,
  } as E;
}

export function traceNow<E extends TraceEvent>(
  sid: string,
  iter: number,
  event: Omit<E, "ts" | "sid" | "iter">,
): E {
  const full = makeTraceEvent<E>(sid, iter, event);
  trace(full);
  return full;
}

const THOUGHT_PATTERN = /<thought>([\s\S]*?)<\/thought>/;

export function parseThought(text: string | undefined | null): string {
  if (!text) return "";
  const m = text.match(THOUGHT_PATTERN);
  return m ? m[1].trim() : "";
}
