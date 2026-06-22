import { describe, it, expect, vi } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import {
  readTraceJsonl,
  aggregateByIter,
  buildPhaseTimeline,
  buildSessionTrace,
  isKnownEvent,
  sumToolCalls,
} from "../trace-aggregator.js";

function evt(overrides: Record<string, unknown>) {
  return { ts: new Date().toISOString(), sid: "test", iter: 0, ...overrides } as any;
}

describe("isKnownEvent", () => {
  it("returns true for known types", () => {
    for (const t of ["llm_request","llm_response","tool_exec","state_change","phase_change","heartbeat","error"]) {
      expect(isKnownEvent({ type: t, ts: "", sid: "", iter: 0 })).toBe(true);
    }
  });
  it("returns false for unknown", () => {
    expect(isKnownEvent({ type: "x", ts: "", sid: "", iter: 0 })).toBe(false);
    expect(isKnownEvent(null)).toBe(false);
  });
});

describe("readTraceJsonl", () => {
  const TMP = "test-tmp.jsonl";

  it("parses valid jsonl", () => {
    writeFileSync(TMP, [
      JSON.stringify(evt({ type: "llm_request", phase: "gathering" })),
      JSON.stringify(evt({ type: "tool_exec", tool: "search_baike", durationMs: 100, fallbackLevel: 0, iter: 1 })),
    ].join("\n"), "utf8");
    const events = readTraceJsonl(TMP);
    expect(events).toHaveLength(2);
    unlinkSync(TMP);
  });

  it("returns [] for empty file", () => {
    writeFileSync(TMP, "", "utf8");
    expect(readTraceJsonl(TMP)).toEqual([]);
    unlinkSync(TMP);
  });

  it("skips malformed lines", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(TMP, [
      JSON.stringify(evt({ type: "tool_exec", tool: "a", iter: 0 })),
      "not-json",
    ].join("\n"), "utf8");
    expect(readTraceJsonl(TMP)).toHaveLength(1);
    vi.restoreAllMocks();
    unlinkSync(TMP);
  });
});

describe("aggregateByIter", () => {
  it("groups by iter", () => {
    const cards = aggregateByIter([
      evt({ type: "llm_request", iter: 0 }),
      evt({ type: "tool_exec", iter: 1, tool: "search_baike" }),
    ]);
    expect(cards).toHaveLength(2);
    expect(cards[0].toolExecs).toHaveLength(0);
    expect(cards[1].toolExecs).toHaveLength(1);
  });

  it("phase_change keeps from-phase", () => {
    const cards = aggregateByIter([
      evt({ type: "phase_change", iter: 2, from: "gathering", to: "searching", reason: "ok" }),
      evt({ type: "llm_request", iter: 3 }),
    ]);
    expect(cards[0].phase).toBe("gathering");
    expect(cards[1].phase).toBe("searching");
  });

  it("collects unknownEvents", () => {
    const cards = aggregateByIter([evt({ type: "future_event", iter: 0 })]);
    expect(cards[0].unknownEvents).toHaveLength(1);
  });

  it("sorts toolExecs by ts", () => {
    const cards = aggregateByIter([
      evt({ type: "tool_exec", iter: 0, tool: "b", ts: "2026-06-22T10:00:02Z" }),
      evt({ type: "tool_exec", iter: 0, tool: "a", ts: "2026-06-22T10:00:01Z" }),
    ]);
    expect(cards[0].toolExecs[0].tool).toBe("a");
  });
});

describe("buildPhaseTimeline", () => {
  it("single segment when no phase_change", () => {
    const tl = buildPhaseTimeline([evt({ type: "llm_request", iter: 0 }), evt({ type: "tool_exec", iter: 2, tool: "x" })]);
    expect(tl).toEqual([{ phase: "gathering", startIter: 0, endIter: 2, iterCount: 3 }]);
  });

  it("empty events → gathering", () => {
    expect(buildPhaseTimeline([])).toEqual([{ phase: "gathering", startIter: 0, endIter: 0, iterCount: 1 }]);
  });

  it("4 phases", () => {
    const tl = buildPhaseTimeline([
      evt({ type: "phase_change", iter: 2, from: "gathering", to: "searching", reason: "a" }),
      evt({ type: "phase_change", iter: 6, from: "searching", to: "selecting", reason: "b" }),
      evt({ type: "phase_change", iter: 8, from: "selecting", to: "planning", reason: "c" }),
      evt({ type: "phase_change", iter: 12, from: "planning", to: "completed", reason: "d" }),
    ]);
    expect(tl.length).toBeGreaterThanOrEqual(4);
    expect(tl[tl.length - 1].phase).toBe("completed");
  });
});

describe("buildSessionTrace stats", () => {
  it("toolCallCount / fallbackUsage / errorCount", () => {
    const session = buildSessionTrace("x", [
      evt({ type: "tool_exec", iter: 0, tool: "search_baike", durationMs: 100, fallbackLevel: 0 }),
      evt({ type: "tool_exec", iter: 1, tool: "search_xhs", durationMs: 200, fallbackLevel: 1 }),
      evt({ type: "tool_exec", iter: 2, tool: "search_xhs", durationMs: 300, fallbackLevel: 2 }),
      evt({ type: "error", iter: 3, error: "e" }),
    ]);
    expect(session.stats.toolCallCount["search_baike"]).toBe(1);
    expect(session.stats.toolCallCount["search_xhs"]).toBe(2);
    expect(session.stats.fallbackUsage["search_xhs"]).toBe(2);
    expect(session.stats.fallbackRate).toBeCloseTo(2 / 3);
    expect(session.stats.errorCount).toBe(1);
  });

  it("fallbackRate = 0 with no calls", () => {
    const s = buildSessionTrace("x", [evt({ type: "llm_request", iter: 0 })]);
    expect(s.stats.fallbackRate).toBe(0);
  });

  it("durationMs from timestamps", () => {
    const s = buildSessionTrace("x", [
      evt({ type: "llm_request", iter: 0, ts: "2026-06-22T10:00:00.000Z" }),
      evt({ type: "tool_exec", iter: 5, tool: "f", ts: "2026-06-22T10:00:47.000Z" }),
    ]);
    expect(s.stats.durationMs).toBe(47000);
  });
});

describe("sumToolCalls", () => {
  it("sums", () => { expect(sumToolCalls({ a: 3, b: 5 })).toBe(8); });
  it("empty → 0", () => { expect(sumToolCalls({})).toBe(0); });
});
