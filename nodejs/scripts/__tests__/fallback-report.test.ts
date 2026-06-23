import { describe, it, expect } from "vitest";
import {
  classifyStatus,
  renderMarkdown,
  generateAlerts,
  aggregateTraceEvents,
  listTraceFiles,
} from "../fallback-report.js";

describe("classifyStatus", () => {
  it("returns healthy for 0%", () => {
    expect(classifyStatus(0)).toBe("healthy");
  });
  it("returns acceptable for 5%", () => {
    expect(classifyStatus(0.05)).toBe("acceptable");
  });
  it("returns watch for 25%", () => {
    expect(classifyStatus(0.25)).toBe("watch");
  });
  it("returns degraded for 35%", () => {
    expect(classifyStatus(0.35)).toBe("degraded");
  });
  it("boundary at 0.20 is watch (exclusive acceptable < 20%)", () => {
    expect(classifyStatus(0.20)).toBe("watch");
  });
  it("boundary at 0.30 is degraded", () => {
    expect(classifyStatus(0.30)).toBe("degraded");
  });
});

describe("aggregateTraceEvents", () => {
  it("empty file list returns empty stats", () => {
    const result = aggregateTraceEvents([], "data/trace", "2026-06");
    expect(result.statsByTool.size).toBe(0);
    expect(result.sessionCount).toBe(0);
  });
});

describe("renderMarkdown", () => {
  it("renders empty stats gracefully", () => {
    const md = renderMarkdown("2026-06", new Map(), 0, 0, 0, []);
    expect(md).toContain("Fallback Report — 2026-06");
    expect(md).toContain("0 个 session");
  });

  it("renders tool with fallback", () => {
    const stats = new Map();
    stats.set("search_xhs", {
      tool: "search_xhs",
      totalCalls: 10,
      fallbackCount: 3,
      byLevel: { 0: 7, 1: 2, 2: 1 },
      fallbackRate: 0.3,
      status: "degraded",
    });
    const md = renderMarkdown("2026-06", stats, 10, 3, 2, []);
    expect(md).toContain("search_xhs");
    expect(md).toContain("L0:7");
    expect(md).toContain("L1:2");
    expect(md).toContain("L2:1");
    expect(md).toContain("30.0%");
  });

  it("shows critical rate in bold", () => {
    const stats = new Map();
    stats.set("search_xhs", {
      tool: "search_xhs",
      totalCalls: 10,
      fallbackCount: 6,
      byLevel: { 0: 4, 1: 3, 2: 3 },
      fallbackRate: 0.6,
      status: "degraded",
    });
    const md = renderMarkdown("2026-06", stats, 10, 6, 1, []);
    expect(md).toContain("**60.0%**");
  });
});

describe("generateAlerts", () => {
  it("generates alert for degraded tool", () => {
    const stats = new Map();
    stats.set("search_xhs", {
      tool: "search_xhs",
      totalCalls: 10,
      fallbackCount: 4,
      byLevel: { 0: 6, 1: 3, 2: 1 },
      fallbackRate: 0.4,
      status: "degraded",
    });
    const alerts = generateAlerts("2026-06", stats);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("search_xhs");
    expect(alerts[0]).toContain("40.0%");
    expect(alerts[0]).toContain("30% 阈值");
  });

  it("skips healthy tools", () => {
    const stats = new Map();
    stats.set("search_baike", {
      tool: "search_baike",
      totalCalls: 10,
      fallbackCount: 0,
      byLevel: { 0: 10 },
      fallbackRate: 0,
      status: "healthy",
    });
    expect(generateAlerts("2026-06", stats)).toHaveLength(0);
  });
});
