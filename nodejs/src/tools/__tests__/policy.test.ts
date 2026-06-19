import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  type ToolName,
  TOOL_FALLBACK_CHAIN,
  isToolAllowedInPhase,
  listToolsForPhase,
  getToolPolicy,
  getAllToolNames,
  TokenBucket,
} from "../policy.js";
import type { Phase } from "../../runtime/state.js";

const ALL_PHASES: Phase[] = ["gathering", "searching", "selecting", "planning", "completed"];

const EXPECTED_PHASE_MATRIX: Record<ToolName, Phase[]> = {
  collect_preferences:   ["gathering"],
  search_baike:          ["searching"],
  search_attractions:    ["searching", "planning"],
  search_restaurants:    ["searching", "planning"],
  search_hotels:         ["searching"],
  search_xhs:            ["searching", "planning"],
  search_weather:        ["searching"],
  search_travel_guides:  ["searching", "planning"],
  search_flights:        ["searching"],
  search_trains:         ["searching"],
  plan_transit:          ["planning"],
  select_transport:      ["selecting"],
  select_hotel:          ["selecting"],
  finalize_plan:         ["planning"],
};

describe("TOOL_PHASE_POLICY matrix (table-driven)", () => {
  const allTools = Object.keys(EXPECTED_PHASE_MATRIX) as ToolName[];

  it.each(allTools)("%s allowed phases match spec", (tool) => {
    const expected = EXPECTED_PHASE_MATRIX[tool];
    for (const phase of ALL_PHASES) {
      const expectedAllowed = expected.includes(phase);
      expect(isToolAllowedInPhase(tool, phase)).toBe(expectedAllowed);
    }
  });

  it("returns false for unknown tool name", () => {
    expect(isToolAllowedInPhase("nonexistent_tool", "gathering")).toBe(false);
    expect(isToolAllowedInPhase("nonexistent_tool", "planning")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isToolAllowedInPhase("", "gathering")).toBe(false);
  });
});

describe("listToolsForPhase", () => {
  function names(phase: Phase): string[] {
    return listToolsForPhase(phase).map(t => t.name).sort();
  }

  it("gathering exposes only collect_preferences", () => {
    expect(names("gathering")).toEqual(["collect_preferences"]);
  });

  it("searching exposes 9 search tools", () => {
    expect(names("searching").sort()).toEqual([
      "search_attractions",
      "search_baike",
      "search_flights",
      "search_hotels",
      "search_restaurants",
      "search_trains",
      "search_travel_guides",
      "search_weather",
      "search_xhs",
    ]);
  });

  it("selecting exposes select_transport + select_hotel", () => {
    expect(names("selecting").sort()).toEqual(["select_hotel", "select_transport"]);
  });

  it("planning exposes 6 tools (search + transit + finalize)", () => {
    expect(names("planning").sort()).toEqual([
      "finalize_plan",
      "plan_transit",
      "search_attractions",
      "search_restaurants",
      "search_travel_guides",
      "search_xhs",
    ]);
  });

  it("completed exposes no tools", () => {
    expect(names("completed")).toEqual([]);
  });

  it("every entry has name + description + allowedPhases", () => {
    for (const phase of ALL_PHASES) {
      for (const entry of listToolsForPhase(phase)) {
        expect(typeof entry.name).toBe("string");
        expect(entry.name.length).toBeGreaterThan(0);
        expect(typeof entry.description).toBe("string");
        expect(entry.description.length).toBeGreaterThan(0);
        expect(Array.isArray(entry.allowedPhases)).toBe(true);
        expect(entry.allowedPhases).toContain(phase);
      }
    }
  });
});

describe("getToolPolicy / getAllToolNames", () => {
  it("returns entry for known tool", () => {
    const entry = getToolPolicy("search_xhs");
    expect(entry?.name).toBe("search_xhs");
    expect(entry?.allowedPhases).toEqual(["searching", "planning"]);
  });

  it("returns undefined for unknown tool", () => {
    expect(getToolPolicy("not_a_tool")).toBeUndefined();
  });

  it("getAllToolNames returns 14 tools", () => {
    expect(getAllToolNames()).toHaveLength(14);
    expect(getAllToolNames()).toContain("collect_preferences");
    expect(getAllToolNames()).toContain("finalize_plan");
    expect(getAllToolNames()).toContain("search_flights");
    expect(getAllToolNames()).toContain("search_trains");
  });
});

describe("TOOL_FALLBACK_CHAIN", () => {
  const noFallbackTools: ToolName[] = [
    "collect_preferences",
    "select_transport",
    "select_hotel",
    "finalize_plan",
  ];

  it.each(noFallbackTools)("%s has empty fallback chain (no external source)", (tool) => {
    expect(TOOL_FALLBACK_CHAIN[tool]).toEqual([]);
  });

  it("search_xhs has 3-level fallback: xhs_service -> web_search_site_filter -> rag_travel_guides", () => {
    expect(TOOL_FALLBACK_CHAIN.search_xhs).toEqual([
      "xhs_service",
      "web_search_site_filter",
      "rag_travel_guides",
    ]);
  });

  it("search_restaurants has 4-level fallback (most diverse)", () => {
    expect(TOOL_FALLBACK_CHAIN.search_restaurants).toEqual([
      "amap_poi",
      "xhs_service",
      "web_search",
      "rag_travel_guides",
    ]);
  });

  it("plan_transit has amap_direction -> haversine_estimate", () => {
    expect(TOOL_FALLBACK_CHAIN.plan_transit).toEqual([
      "amap_direction",
      "haversine_estimate",
    ]);
  });

  it("all search/transit tools have at least 2 fallback levels", () => {
    const required: ToolName[] = [
      "search_baike", "search_attractions", "search_restaurants",
      "search_hotels", "search_xhs", "search_weather",
      "search_travel_guides", "plan_transit",
    ];
    for (const tool of required) {
      expect(TOOL_FALLBACK_CHAIN[tool].length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("TokenBucket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-17T10:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts full at capacity", () => {
    const bucket = new TokenBucket(3, 3);
    expect(bucket.getTokens()).toBe(3);
  });

  it("tryAcquire returns true capacity times, then false", () => {
    const bucket = new TokenBucket(3, 3);
    expect(bucket.tryAcquire()).toBe(true);
    expect(bucket.tryAcquire()).toBe(true);
    expect(bucket.tryAcquire()).toBe(true);
    expect(bucket.tryAcquire()).toBe(false);
    expect(bucket.getTokens()).toBeLessThan(1);
  });

  it("refills proportional to elapsed time (capped at capacity)", () => {
    const bucket = new TokenBucket(3, 3);
    bucket.tryAcquire();
    bucket.tryAcquire();
    bucket.tryAcquire();
    expect(bucket.getTokens()).toBeLessThan(1);

    vi.advanceTimersByTime(1000);
    expect(bucket.getTokens()).toBeCloseTo(3, 0);

    vi.advanceTimersByTime(10_000);
    expect(bucket.getTokens()).toBe(3);
  });

  it("acquire returns 0 waitMs when tokens available", async () => {
    const bucket = new TokenBucket(3, 3);
    const waitMs = await bucket.acquire();
    expect(waitMs).toBe(0);
  });

  it("acquire waits when bucket exhausted, then returns waitMs > 0", async () => {
    const bucket = new TokenBucket(1, 1);
    expect(await bucket.acquire()).toBe(0);

    const acquirePromise = bucket.acquire();
    vi.advanceTimersByTime(1500);
    const waitMs = await acquirePromise;
    expect(waitMs).toBeGreaterThan(0);
  });

  it("handles fractional refill correctly (capped at capacity)", () => {
    const bucket = new TokenBucket(5, 3);
    bucket.tryAcquire();
    bucket.tryAcquire();
    expect(bucket.getTokens()).toBeCloseTo(3, 0);

    vi.advanceTimersByTime(500);
    expect(bucket.getTokens()).toBeCloseTo(3 + 1.5, 0);
  });

  it("does not refill when no time elapsed", () => {
    const bucket = new TokenBucket(3, 3);
    bucket.tryAcquire();
    const after = bucket.getTokens();
    expect(bucket.getTokens()).toBe(after);
  });

  it("amap config: capacity=3, refill=3/s -> 3 immediate calls, 4th must wait ~333ms", async () => {
    const bucket = new TokenBucket(3, 3);
    expect(await bucket.acquire()).toBe(0);
    expect(await bucket.acquire()).toBe(0);
    expect(await bucket.acquire()).toBe(0);

    const promise = bucket.acquire();
    vi.advanceTimersByTime(500);
    const waitMs = await promise;
    expect(waitMs).toBeGreaterThan(0);
  });
});
