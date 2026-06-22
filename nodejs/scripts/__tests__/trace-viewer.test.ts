import { describe, it, expect } from "vitest";
import { readTraceJsonl, buildSessionTrace } from "../trace-aggregator.js";
import { renderHtml } from "../trace-html-renderer.js";

const FIXTURES = ["happy-path", "fallback-recovery", "json-repair", "phase-stuck"];

describe("trace-viewer snapshots", () => {
  for (const name of FIXTURES) {
    it(`renders ${name} fixture`, () => {
      const events = readTraceJsonl(`scripts/_trace-fixtures/${name}.jsonl`);
      expect(events.length).toBeGreaterThan(0);
      const session = buildSessionTrace(name, events);
      const html = renderHtml(session);
      expect(html).toMatchSnapshot();
      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain(name);
    });
  }
});

describe("trace-viewer data integrity", () => {
  it("happy-path: 6 iters, >=4 phases, 0 fallback, 0 errors", () => {
    const s = buildSessionTrace("happy-path", readTraceJsonl("scripts/_trace-fixtures/happy-path.jsonl"));
    expect(s.stats.totalIters).toBe(6);
    expect(s.phaseTimeline.length).toBeGreaterThanOrEqual(4);
    expect(s.stats.fallbackRate).toBe(0);
    expect(s.stats.errorCount).toBe(0);
  });

  it("fallback-recovery: has L1 and L2 fallbacks", () => {
    const s = buildSessionTrace("fallback-recovery", readTraceJsonl("scripts/_trace-fixtures/fallback-recovery.jsonl"));
    const hasL1 = s.events.some((e) => e.type === "tool_exec" && e.fallbackLevel === 1);
    const hasL2 = s.events.some((e) => e.type === "tool_exec" && e.fallbackLevel === 2);
    expect(hasL1).toBe(true);
    expect(hasL2).toBe(true);
    expect(s.stats.fallbackRate).toBeGreaterThan(0);
  });

  it("json-repair: 3 errors, ends at completed", () => {
    const s = buildSessionTrace("json-repair", readTraceJsonl("scripts/_trace-fixtures/json-repair.jsonl"));
    expect(s.stats.errorCount).toBe(3);
    const lastSeg = s.phaseTimeline[s.phaseTimeline.length - 1];
    expect(lastSeg.phase).toBe("completed");
  });

  it("phase-stuck: 3 errors, force_finish", () => {
    const s = buildSessionTrace("phase-stuck", readTraceJsonl("scripts/_trace-fixtures/phase-stuck.jsonl"));
    expect(s.stats.errorCount).toBe(3);
    const lastSeg = s.phaseTimeline[s.phaseTimeline.length - 1];
    expect(lastSeg.phase).toBe("completed");
    expect(lastSeg.reason).toContain("force_finish");
  });

  it("all fixtures produce HTML under 500KB", () => {
    for (const name of FIXTURES) {
      const s = buildSessionTrace(name, readTraceJsonl(`scripts/_trace-fixtures/${name}.jsonl`));
      const html = renderHtml(s);
      expect(Buffer.byteLength(html, "utf8")).toBeLessThan(500 * 1024);
    }
  });
});
