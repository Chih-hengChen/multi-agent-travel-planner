import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  type ToolCall,
  validateToolCalls,
  stableHash,
  PRECONDITIONS,
} from "../validate-tool-calls.js";
import { type AgentState, createInitialAgentState } from "../state.js";

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return { ...createInitialAgentState(), ...overrides };
}

function emptySchemaLookup() {
  return () => undefined;
}

function schemaLookupWith(map: Record<string, z.ZodType>) {
  return (name: string) => map[name];
}

describe("stableHash", () => {
  it("produces same hash regardless of key order", () => {
    const a = stableHash({ x: 1, y: 2, z: 3 });
    const b = stableHash({ z: 3, y: 2, x: 1 });
    expect(a).toBe(b);
  });

  it("treats different values as different hashes", () => {
    expect(stableHash({ x: 1 })).not.toBe(stableHash({ x: 2 }));
  });

  it("handles nested objects recursively", () => {
    const a = stableHash({ outer: { b: 2, a: 1 }, list: [1, 2] });
    const b = stableHash({ outer: { a: 1, b: 2 }, list: [1, 2] });
    expect(a).toBe(b);
  });

  it("array order matters (not sorted)", () => {
    expect(stableHash({ list: [1, 2] })).not.toBe(stableHash({ list: [2, 1] }));
  });

  it("handles primitives directly", () => {
    expect(stableHash("hello")).toBe(stableHash("hello"));
    expect(stableHash(42)).toBe(stableHash(42));
  });
});

describe("validateToolCalls - PHASE_NOT_ALLOWED", () => {
  it("rejects tool not allowed in current phase", () => {
    const state = makeState({ phase: "gathering" });
    const result = validateToolCalls(
      [{ name: "search_attractions", input: {} }],
      state,
      emptySchemaLookup(),
    );
    expect(result.approved).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].code).toBe("PHASE_NOT_ALLOWED");
    expect(result.rejected[0].reason).toContain("search_attractions");
    expect(result.rejected[0].reason).toContain("gathering");
    expect(result.rejected[0].reason).toContain("collect_preferences");
  });

  it("rejects unknown tool name (isToolAllowedInPhase returns false)", () => {
    const state = makeState({ phase: "planning" });
    const result = validateToolCalls(
      [{ name: "nonexistent_tool", input: {} }],
      state,
      emptySchemaLookup(),
    );
    expect(result.rejected[0].code).toBe("PHASE_NOT_ALLOWED");
  });

  it("lists 'no tools' for completed phase", () => {
    const state = makeState({ phase: "completed" });
    const result = validateToolCalls(
      [{ name: "search_attractions", input: {} }],
      state,
      emptySchemaLookup(),
    );
    expect(result.rejected[0].reason).toContain("(无)");
  });
});

describe("validateToolCalls - SCHEMA_INVALID", () => {
  it("rejects when schema validation fails", () => {
    const state = makeState({ phase: "gathering" });
    const schema = z.object({
      destination: z.string().min(1),
      budget: z.number().positive(),
    });
    const result = validateToolCalls(
      [{ name: "collect_preferences", input: { destination: "", budget: -100 } }],
      state,
      schemaLookupWith({ collect_preferences: schema }),
    );
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].code).toBe("SCHEMA_INVALID");
    expect(result.rejected[0].reason).toContain("参数校验失败");
  });

  it("normalizes input through schema (parsed.data replaces raw input)", () => {
    const state = makeState({ phase: "gathering" });
    const schema = z.object({
      count: z.number().int().default(5),
      name: z.string(),
    });
    const result = validateToolCalls(
      [{ name: "collect_preferences", input: { name: "abc" } }],
      state,
      schemaLookupWith({ collect_preferences: schema }),
    );
    expect(result.approved).toHaveLength(1);
    expect(result.approved[0].input).toEqual({ name: "abc", count: 5 });
  });

  it("skips schema check when lookup returns undefined", () => {
    const state = makeState({ phase: "searching" });
    const result = validateToolCalls(
      [{ name: "search_baike", input: { any: "thing" } }],
      state,
      emptySchemaLookup(),
    );
    expect(result.approved).toHaveLength(1);
    expect(result.approved[0].input).toEqual({ any: "thing" });
  });
});

describe("validateToolCalls - DUPLICATE_CALL", () => {
  it("rejects same name + same params within one iter", () => {
    const state = makeState({ phase: "searching" });
    const call = { name: "search_attractions", input: { city: "东京" } };
    const result = validateToolCalls([call, call], state, emptySchemaLookup());
    expect(result.approved).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].code).toBe("DUPLICATE_CALL");
  });

  it("does NOT dedupe when params differ", () => {
    const state = makeState({ phase: "searching" });
    const result = validateToolCalls(
      [
        { name: "search_attractions", input: { city: "东京" } },
        { name: "search_attractions", input: { city: "京都" } },
      ],
      state,
      emptySchemaLookup(),
    );
    expect(result.approved).toHaveLength(2);
    expect(result.rejected).toHaveLength(0);
  });

  it("dedupe is order-independent (stable hash)", () => {
    const state = makeState({ phase: "searching" });
    const result = validateToolCalls(
      [
        { name: "search_attractions", input: { city: "东京", interests: ["food"] } },
        { name: "search_attractions", input: { interests: ["food"], city: "东京" } },
      ],
      state,
      emptySchemaLookup(),
    );
    expect(result.approved).toHaveLength(1);
    expect(result.rejected[0].code).toBe("DUPLICATE_CALL");
  });
});

describe("validateToolCalls - PRECONDITION_MISSING", () => {
  it("select_transport: blocked at PHASE_NOT_ALLOWED (allowedPhases=[])", () => {
    const state = makeState({
      phase: "selecting",
      candidateTransports: [],
    });
    const result = validateToolCalls(
      [{ name: "select_transport", input: { outboundId: "X", returnId: "Y" } }],
      state,
      emptySchemaLookup(),
    );
    expect(result.rejected[0].code).toBe("PHASE_NOT_ALLOWED");
  });

  it("select_transport: blocked at PHASE_NOT_ALLOWED even with data", () => {
    const state = makeState({
      phase: "selecting",
      candidateTransports: [{ id: "X" } as any],
    });
    const result = validateToolCalls(
      [{ name: "select_transport", input: { outboundId: "X", returnId: "Y" } }],
      state,
      emptySchemaLookup(),
    );
    expect(result.rejected[0].code).toBe("PHASE_NOT_ALLOWED");
  });

  it("finalize_plan: rejects when not all 3 selected", () => {
    const state = makeState({
      phase: "planning",
      selectedOutbound: { id: "X" } as any,
      selectedHotel: { name: "H" } as any,
    });
    const result = validateToolCalls(
      [{ name: "finalize_plan", input: { rawJson: "{}" } }],
      state,
      emptySchemaLookup(),
    );
    expect(result.rejected[0].code).toBe("PRECONDITION_MISSING");
    expect(result.rejected[0].reason).toContain("selectedOutbound");
  });

  it("finalize_plan: passes when all 3 selected", () => {
    const state = makeState({
      phase: "planning",
      selectedOutbound: { id: "X" } as any,
      selectedReturn: { id: "Y" } as any,
      selectedHotel: { name: "H" } as any,
    });
    const result = validateToolCalls(
      [{ name: "finalize_plan", input: { rawJson: "{}" } }],
      state,
      emptySchemaLookup(),
    );
    expect(result.approved).toHaveLength(1);
  });

  it("search_restaurants scope=city: no precondition check", () => {
    const state = makeState({ phase: "searching" });
    const result = validateToolCalls(
      [{ name: "search_restaurants", input: { scope: "city", city: "东京" } }],
      state,
      emptySchemaLookup(),
    );
    expect(result.approved).toHaveLength(1);
  });

  it("search_restaurants scope=attraction: rejects when candidateAttractions empty", () => {
    const state = makeState({
      phase: "planning",
      candidateAttractions: [],
    });
    const result = validateToolCalls(
      [{ name: "search_restaurants", input: { scope: "attraction", near: "故宫" } }],
      state,
      emptySchemaLookup(),
    );
    expect(result.rejected[0].code).toBe("PRECONDITION_MISSING");
    expect(result.rejected[0].reason).toContain("candidateAttractions");
  });

  it("search_restaurants scope=attraction: passes when candidateAttractions non-empty", () => {
    const state = makeState({
      phase: "planning",
      candidateAttractions: [{ name: "故宫" } as any],
    });
    const result = validateToolCalls(
      [{ name: "search_restaurants", input: { scope: "attraction", near: "故宫" } }],
      state,
      emptySchemaLookup(),
    );
    expect(result.approved).toHaveLength(1);
  });
});

describe("validateToolCalls - mixed batches", () => {
  it("handles multiple approved and rejected in one call", () => {
    const state = makeState({
      phase: "searching",
      candidateHotels: [{ name: "H" } as any],
    });
    const result = validateToolCalls(
      [
        { name: "search_attractions", input: { city: "东京" } },
        { name: "collect_preferences", input: {} },
        { name: "search_attractions", input: { city: "东京" } },
        { name: "search_baike", input: { q: "tokyo" } },
      ],
      state,
      emptySchemaLookup(),
    );
    expect(result.approved).toHaveLength(2);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected.map(r => r.code).sort()).toEqual(["DUPLICATE_CALL", "PHASE_NOT_ALLOWED"]);
  });

  it("empty input array returns empty result", () => {
    const state = makeState({ phase: "planning" });
    const result = validateToolCalls([], state, emptySchemaLookup());
    expect(result.approved).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it("preserves call.id through validation", () => {
    const state = makeState({ phase: "searching" });
    const result = validateToolCalls(
      [{ id: "tool_use_abc", name: "search_baike", input: {} }],
      state,
      emptySchemaLookup(),
    );
    expect(result.approved[0].id).toBe("tool_use_abc");
  });

  it("same precondition-failing call returns PRECONDITION_MISSING both times (not DUPLICATE)", () => {
    const state = makeState({
      phase: "planning",
      selectedOutbound: { id: "X" } as any,
      selectedReturn: { id: "Y" } as any,
    });
    const result = validateToolCalls(
      [
        { name: "finalize_plan", input: { rawJson: "{}" } },
        { name: "finalize_plan", input: { rawJson: "{}" } },
      ],
      state,
      emptySchemaLookup(),
    );
    expect(result.approved).toHaveLength(0);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected[0].code).toBe("PRECONDITION_MISSING");
    expect(result.rejected[1].code).toBe("PRECONDITION_MISSING");
  });
});

describe("PRECONDITIONS table", () => {
  it("has exactly 4 precondition entries", () => {
    expect(Object.keys(PRECONDITIONS).sort()).toEqual([
      "finalize_plan",
      "search_restaurants",
      "select_hotel",
      "select_transport",
    ]);
  });

  it("every entry has check function and desc string", () => {
    for (const [name, entry] of Object.entries(PRECONDITIONS)) {
      expect(typeof entry.check).toBe("function");
      expect(typeof entry.desc).toBe("string");
      expect(entry.desc.length).toBeGreaterThan(0);
    }
  });
});
