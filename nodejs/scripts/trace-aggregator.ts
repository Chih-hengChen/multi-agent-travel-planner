import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  TraceEvent,
  LlmRequestTraceEvent,
  LlmResponseTraceEvent,
  ToolExecTraceEvent,
  StateChangeTraceEvent,
  PhaseChangeTraceEvent,
  ErrorTraceEvent,
  HeartbeatTraceEvent,
} from "../src/runtime/trace.js";
import type { Phase } from "../src/runtime/state.js";

export interface UnknownTraceEvent {
  ts: string;
  sid: string;
  iter: number;
  type: string;
  [key: string]: unknown;
}

export interface IterCard {
  iter: number;
  phase: Phase;
  llmRequest?: LlmRequestTraceEvent;
  llmResponse?: LlmResponseTraceEvent;
  toolExecs: ToolExecTraceEvent[];
  stateChanges: StateChangeTraceEvent[];
  errors: ErrorTraceEvent[];
  heartbeats: HeartbeatTraceEvent[];
  unknownEvents: UnknownTraceEvent[];
}

export interface PhaseSegment {
  phase: Phase;
  startIter: number;
  endIter: number;
  iterCount: number;
  reason?: string;
}

export interface SessionTrace {
  sid: string;
  events: TraceEvent[];
  iterCards: IterCard[];
  phaseTimeline: PhaseSegment[];
  stats: {
    totalIters: number;
    totalEvents: number;
    phaseDistribution: Record<Phase, number>;
    toolCallCount: Record<string, number>;
    fallbackUsage: Record<string, number>;
    fallbackRate: number;
    errorCount: number;
    durationMs: number;
  };
}

const KNOWN_TYPES = new Set([
  "llm_request",
  "llm_response",
  "tool_exec",
  "state_change",
  "phase_change",
  "heartbeat",
  "error",
]);

export function isKnownEvent(e: unknown): e is TraceEvent {
  if (!e || typeof e !== "object") return false;
  const type = (e as { type?: unknown }).type;
  return typeof type === "string" && KNOWN_TYPES.has(type);
}

export function listSessions(traceDir: string): Array<{ sid: string; mtimeMs: number }> {
  try {
    return readdirSync(traceDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({
        sid: f.replace(/\.jsonl$/, ""),
        mtimeMs: statSync(join(traceDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return [];
  }
}

export function readTraceJsonl(filePath: string): TraceEvent[] {
  const raw = readFileSync(filePath, "utf8");
  const events: TraceEvent[] = [];
  const lines = raw.split("\n");
  const malformed: Array<{ lineNo: number; excerpt: string }> = [];

  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed);
      if (isKnownEvent(parsed)) {
        events.push(parsed as TraceEvent);
      } else {
        malformed.push({ lineNo: idx + 1, excerpt: trimmed.slice(0, 80) });
      }
    } catch {
      malformed.push({ lineNo: idx + 1, excerpt: trimmed.slice(0, 80) });
    }
  });

  if (malformed.length > 0) {
    console.warn(
      `[trace-aggregator] ${malformed.length} malformed line(s) in ${filePath} (first: L${malformed[0].lineNo}: ${malformed[0].excerpt})`,
    );
  }
  return events;
}

export function aggregateByIter(events: TraceEvent[]): IterCard[] {
  const byIter = new Map<number, IterCard>();
  let currentPhase: Phase = "gathering";

  for (const e of events) {
    let card = byIter.get(e.iter);
    if (!card) {
      card = {
        iter: e.iter,
        phase: currentPhase,
        toolExecs: [],
        stateChanges: [],
        errors: [],
        heartbeats: [],
        unknownEvents: [],
      };
      byIter.set(e.iter, card);
    }

    switch (e.type) {
      case "llm_request":
        card.llmRequest = e as LlmRequestTraceEvent;
        break;
      case "llm_response":
        card.llmResponse = e as LlmResponseTraceEvent;
        break;
      case "tool_exec":
        card.toolExecs.push(e as ToolExecTraceEvent);
        break;
      case "state_change":
        card.stateChanges.push(e as StateChangeTraceEvent);
        break;
      case "phase_change": {
        const pc = e as PhaseChangeTraceEvent;
        card.phase = pc.from;
        currentPhase = pc.to;
        break;
      }
      case "heartbeat":
        card.heartbeats.push(e as HeartbeatTraceEvent);
        break;
      case "error":
        card.errors.push(e as ErrorTraceEvent);
        break;
      default:
        card.unknownEvents.push(e as UnknownTraceEvent);
    }
  }

  const cards = Array.from(byIter.values());
  for (const card of cards) {
    card.toolExecs.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  }

  return cards.sort((a, b) => a.iter - b.iter);
}

export function buildPhaseTimeline(events: TraceEvent[]): PhaseSegment[] {
  const phaseChanges = events
    .filter((e) => e.type === "phase_change")
    .sort((a, b) => a.iter - b.iter) as PhaseChangeTraceEvent[];

  if (phaseChanges.length === 0) {
    const iters = events.map((e) => e.iter);
    const maxIter = iters.length > 0 ? Math.max(...iters) : 0;
    const minIter = iters.length > 0 ? Math.min(...iters) : 0;
    return [
      {
        phase: "gathering",
        startIter: minIter,
        endIter: maxIter,
        iterCount: maxIter - minIter + 1,
      },
    ];
  }

  const segments: PhaseSegment[] = [];
  let prev = { phase: phaseChanges[0].from, iter: 0, reason: undefined as string | undefined };

  for (const pc of phaseChanges) {
    if (pc.iter >= prev.iter) {
      segments.push({
        phase: prev.phase,
        startIter: prev.iter,
        endIter: pc.iter,
        iterCount: pc.iter - prev.iter + 1,
        reason: pc.reason,
      });
    }
    prev = { phase: pc.to, iter: pc.iter + 1, reason: pc.reason };
  }

  const iters = events.map((e) => e.iter);
  const lastIter = iters.length > 0 ? Math.max(...iters) : prev.iter - 1;

  segments.push({
    phase: prev.phase,
    startIter: prev.iter,
    endIter: Math.max(prev.iter, lastIter),
    iterCount: Math.max(0, Math.max(prev.iter, lastIter) - prev.iter) + 1,
    reason: prev.reason,
  });

  return segments;
}

export function buildSessionTrace(sid: string, events: TraceEvent[]): SessionTrace {
  const iterCards = aggregateByIter(events);
  const phaseTimeline = buildPhaseTimeline(events);

  const toolCallCount: Record<string, number> = {};
  const fallbackUsage: Record<string, number> = {};
  let fallbackTotal = 0;
  let callsTotal = 0;
  let errorCount = 0;

  for (const e of events) {
    if (e.type === "tool_exec") {
      toolCallCount[e.tool] = (toolCallCount[e.tool] ?? 0) + 1;
      callsTotal++;
      if (e.fallbackLevel > 0) {
        fallbackUsage[e.tool] = (fallbackUsage[e.tool] ?? 0) + 1;
        fallbackTotal++;
      }
    } else if (e.type === "error") {
      errorCount++;
    }
  }

  const phaseDistribution: Record<Phase, number> = {
    gathering: 0,
    searching: 0,
    selecting: 0,
    planning: 0,
    completed: 0,
  };
  for (const seg of phaseTimeline) {
    phaseDistribution[seg.phase] += seg.iterCount;
  }

  const timestamps = events
    .map((e) => Date.parse(e.ts))
    .filter((t) => !Number.isNaN(t));
  const durationMs =
    timestamps.length >= 2 ? Math.max(...timestamps) - Math.min(...timestamps) : 0;

  return {
    sid,
    events,
    iterCards,
    phaseTimeline,
    stats: {
      totalIters: iterCards.length,
      totalEvents: events.length,
      phaseDistribution,
      toolCallCount,
      fallbackUsage,
      fallbackRate: callsTotal > 0 ? fallbackTotal / callsTotal : 0,
      errorCount,
      durationMs,
    },
  };
}

export function sumToolCalls(toolCallCount: Record<string, number>): number {
  return Object.values(toolCallCount).reduce((s, n) => s + n, 0);
}
