import { describe, it, expect } from "vitest";
import {
  applyToolEffects,
  applyFinalizePlan,
  TOOL_EFFECT_HANDLERS,
  type ToolResultLike,
} from "../apply-tool-effects.js";
import {
  type AgentState,
  type PlanDayPlan,
  type BudgetBreakdownV2,
  type TransitSegment,
  type XhsNote,
  MAX_BUDGET_ROUNDS,
  createInitialAgentState,
} from "../state.js";
import type { Activity, UserPreferences } from "../../types/index.js";

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return { ...createInitialAgentState(), ...overrides };
}

function makeActivity(name: string): Activity {
  return {
    name,
    category: "attraction",
    location: "测试",
    durationHours: 2,
    price: 0,
    rating: 8,
    description: "",
    timeSlot: "",
  } as any;
}

function makeNote(noteId: string): XhsNote {
  return {
    noteId,
    title: `note-${noteId}`,
    content: "content",
    likedCount: 100,
    author: "a",
    tags: [],
  };
}

function makeBudget(over: Partial<BudgetBreakdownV2> = {}): BudgetBreakdownV2 {
  return {
    totalCost: 100,
    byCategory: { transport: 0, accommodation: 0, food: 0, attractions: 0, other: 0 },
    budgetLimit: 1000,
    isWithinBudget: true,
    variance: -900,
    ...over,
  };
}

function makePrefs(over: Partial<UserPreferences> = {}): UserPreferences {
  return {
    budget: 15000,
    travelStyle: "comfort" as any,
    departureCity: "北京",
    startDate: "2026-07-01",
    endDate: "2026-07-02",
    numTravelers: 2,
    interests: [],
    dietaryRestrictions: [],
    accessibilityNeeds: [],
    notes: "",
    outboundTransportPreference: "no_preference",
    returnTransportPreference: "no_preference",
    mustVisitAttractions: [],
    departureTime: "flexible",
    budgetStrictness: "strict",
    accommodationType: "any",
    preferredHotelBrands: [],
    localTransitMode: "mixed",
    diningPreference: "local_specialties",
    preferredDestination: "东京",
    ...over,
  } as UserPreferences;
}

describe("TOOL_EFFECT_HANDLERS table", () => {
  it("has handlers for all 14 tools", () => {
    const expected = [
      "collect_preferences", "search_baike", "search_weather",
      "search_attractions", "search_hotels", "search_restaurants",
      "search_xhs", "search_travel_guides",
      "search_flights", "search_trains",
      "select_transport", "select_hotel",
      "plan_transit", "finalize_plan",
    ];
    expect(Object.keys(TOOL_EFFECT_HANDLERS).sort()).toEqual(expected.sort());
  });

  it("search_travel_guides is a no-op (returns same state reference)", () => {
    const state = makeState();
    const result = TOOL_EFFECT_HANDLERS.search_travel_guides(state, { anything: true });
    expect(result).toBe(state);
  });
});

describe("search_attractions / search_hotels handler (appendCandidates)", () => {
  it("appends to candidateAttractions and writes rerankScores", () => {
    const state = makeState();
    const result = TOOL_EFFECT_HANDLERS.search_attractions(state, {
      items: [makeActivity("故宫"), makeActivity("天坛")],
      scores: { "故宫": 0.92, "天坛": 0.85 },
    });
    expect(result.candidateAttractions?.map(a => a.name)).toEqual(["故宫", "天坛"]);
    expect(result.rerankScores["故宫"]).toBe(0.92);
    expect(result.rerankScores["天坛"]).toBe(0.85);
  });

  it("dedupes by name on second call", () => {
    let state = makeState();
    state = TOOL_EFFECT_HANDLERS.search_attractions(state, {
      items: [makeActivity("故宫")],
      scores: { "故宫": 0.9 },
    });
    state = TOOL_EFFECT_HANDLERS.search_attractions(state, {
      items: [makeActivity("故宫"), makeActivity("天坛")],
      scores: { "故宫": 0.95, "天坛": 0.8 },
    });
    expect(state.candidateAttractions?.map(a => a.name)).toEqual(["故宫", "天坛"]);
    expect(state.rerankScores["故宫"]).toBe(0.9);
  });

  it("appends to candidateHotels (separate field)", () => {
    const state = makeState();
    const result = TOOL_EFFECT_HANDLERS.search_hotels(state, {
      items: [makeActivity("H1")],
      scores: { "H1": 0.7 },
    });
    expect(result.candidateHotels?.map(a => a.name)).toEqual(["H1"]);
    expect(result.candidateAttractions).toBeUndefined();
  });

  it("returns new state object (immutable)", () => {
    const state = makeState();
    const result = TOOL_EFFECT_HANDLERS.search_attractions(state, { items: [], scores: {} });
    expect(result).not.toBe(state);
  });
});

describe("search_restaurants handler (city vs attraction)", () => {
  it("scope=city appends to candidateRestaurants", () => {
    const state = makeState();
    const result = TOOL_EFFECT_HANDLERS.search_restaurants(state, {
      scope: "city",
      items: [makeActivity("全聚德")],
      scores: { "全聚德": 0.7 },
    });
    expect(result.candidateRestaurants?.map(a => a.name)).toEqual(["全聚德"]);
    expect(result.planningRestaurants).toBeUndefined();
  });

  it("scope=attraction appends to planningRestaurants[near]", () => {
    const state = makeState();
    const result = TOOL_EFFECT_HANDLERS.search_restaurants(state, {
      scope: "attraction",
      near: "故宫",
      items: [makeActivity("R1"), makeActivity("R2")],
      scores: { "R1": 0.8, "R2": 0.7 },
    });
    expect(result.planningRestaurants?.["故宫"]?.map(a => a.name)).toEqual(["R1", "R2"]);
    expect(result.candidateRestaurants).toBeUndefined();
  });

  it("scope=attraction dedupes by name within same near", () => {
    let state = makeState();
    state = TOOL_EFFECT_HANDLERS.search_restaurants(state, {
      scope: "attraction", near: "故宫",
      items: [makeActivity("R1")], scores: {},
    });
    state = TOOL_EFFECT_HANDLERS.search_restaurants(state, {
      scope: "attraction", near: "故宫",
      items: [makeActivity("R1"), makeActivity("R2")], scores: {},
    });
    expect(state.planningRestaurants?.["故宫"]?.map(a => a.name)).toEqual(["R1", "R2"]);
  });

  it("scope=attraction different near does not collide", () => {
    let state = makeState();
    state = TOOL_EFFECT_HANDLERS.search_restaurants(state, {
      scope: "attraction", near: "故宫", items: [makeActivity("R1")], scores: {},
    });
    state = TOOL_EFFECT_HANDLERS.search_restaurants(state, {
      scope: "attraction", near: "天坛", items: [makeActivity("R2")], scores: {},
    });
    expect(state.planningRestaurants?.["故宫"]?.map(a => a.name)).toEqual(["R1"]);
    expect(state.planningRestaurants?.["天坛"]?.map(a => a.name)).toEqual(["R2"]);
  });
});

describe("search_xhs handler (mergeXhsNotes)", () => {
  it("dedupes by noteId", () => {
    let state = makeState();
    state = TOOL_EFFECT_HANDLERS.search_xhs(state, { notes: [makeNote("n1"), makeNote("n2")] });
    state = TOOL_EFFECT_HANDLERS.search_xhs(state, { notes: [makeNote("n2"), makeNote("n3")] });
    expect(state.xhsNotes?.map(n => n.noteId)).toEqual(["n1", "n2", "n3"]);
  });

  it("accepts both 'notes' and 'top' field name (legacy compat)", () => {
    const state = makeState();
    const result = TOOL_EFFECT_HANDLERS.search_xhs(state, { top: [makeNote("n1")] });
    expect(result.xhsNotes?.map(n => n.noteId)).toEqual(["n1"]);
  });
});

describe("plan_transit handler (appendTransit)", () => {
  function makePlan(dayIdx: number): PlanDayPlan {
    return { dayIdx, date: `2026-07-${dayIdx + 1}`, dining: [], transitTips: [] };
  }

  function makeTransit(from: string, to: string): TransitSegment {
    return {
      from, to, mode: "walking", durationMin: 10, distanceKm: 1,
      cost: "¥0", costAmount: 0, steps: [], fallbackLevel: 0,
    };
  }

  it("appends transit tip to correct day", () => {
    const state = makeState({ dayPlans: [makePlan(0), makePlan(1)] });
    const transit = makeTransit("故宫", "天坛");
    const result = TOOL_EFFECT_HANDLERS.plan_transit(state, { dayIdx: 0, transit });
    expect(result.dayPlans?.[0].transitTips).toContain("故宫 → 天坛: walking 10min ¥0");
    expect(result.dayPlans?.[1].transitTips).toEqual([]);
  });

  it("out-of-range dayIdx records error, does not crash", () => {
    const state = makeState({ dayPlans: [makePlan(0)] });
    const result = TOOL_EFFECT_HANDLERS.plan_transit(state, { dayIdx: 5, transit: makeTransit("A", "B") });
    expect(result.errorMessages.length).toBe(1);
    expect(result.errorMessages[0]).toContain("越界");
  });

  it("appends multiple transits to same day", () => {
    let state = makeState({ dayPlans: [makePlan(0)] });
    state = TOOL_EFFECT_HANDLERS.plan_transit(state, { dayIdx: 0, transit: makeTransit("A", "B") });
    state = TOOL_EFFECT_HANDLERS.plan_transit(state, { dayIdx: 0, transit: makeTransit("B", "C") });
    expect(state.dayPlans?.[0].transitTips).toHaveLength(2);
  });
});

describe("select_transport / select_hotel", () => {
  it("select_transport resolves outboundId + returnId from candidateTransports", () => {
    const state = makeState({
      candidateTransports: [
        { id: "out", mode: "flight", departStation: "A", arriveStation: "B", departTime: "08:00", arriveTime: "10:00", duration: "2h", price: 1000, isRecommended: false },
        { id: "ret", mode: "flight", departStation: "B", arriveStation: "A", departTime: "20:00", arriveTime: "22:00", duration: "2h", price: 1200, isRecommended: false },
      ] as any,
    });
    const result = TOOL_EFFECT_HANDLERS.select_transport(state, {
      outboundId: "out", returnId: "ret",
    });
    expect(result.selectedOutbound?.id).toBe("out");
    expect(result.selectedReturn?.id).toBe("ret");
  });

  it("select_transport records error when id not found", () => {
    const state = makeState({ candidateTransports: [] as any });
    const result = TOOL_EFFECT_HANDLERS.select_transport(state, {
      outboundId: "missing", returnId: "missing",
    });
    expect(result.selectedOutbound).toBeUndefined();
    expect(result.errorMessages.some(e => e.includes("missing"))).toBe(true);
  });

  it("select_hotel resolves hotelId from candidateHotels", () => {
    const state = makeState({
      candidateHotels: [
        { name: "H1", city: "X", address: "", starRating: 4, userRating: 8, pricePerNight: 500, amenities: [], distanceToCenterKm: 0 } as any,
      ],
    });
    const result = TOOL_EFFECT_HANDLERS.select_hotel(state, { hotelId: "H1" });
    expect(result.selectedHotel?.name).toBe("H1");
  });
});

describe("search_baike / search_weather", () => {
  it("search_baike writes summary to baikeKnowledge", () => {
    const state = makeState();
    const result = TOOL_EFFECT_HANDLERS.search_baike(state, { summary: "Tokyo is..." });
    expect(result.baikeKnowledge).toBe("Tokyo is...");
  });

  it("search_weather writes weather object", () => {
    const state = makeState();
    const weather = { date: "2026-07-01", weather: "sunny", highC: 31, lowC: 22, rainProbability: 0.1 };
    const result = TOOL_EFFECT_HANDLERS.search_weather(state, weather);
    expect(result.weather).toEqual(weather);
  });
});

describe("applyFinalizePlan (3 paths)", () => {
  const basePlan = { dayPlans: [{ dayIdx: 0, date: "2026-07-01", dining: [], transitTips: [] }] };
  const baseBreakdown = makeBudget({ isWithinBudget: true });

  it("withinBudget=true: writes dayPlans + budget, no phase change", () => {
    const state = makeState({ phase: "planning", budgetRound: 0 });
    const result = applyFinalizePlan(state, {
      plan: basePlan, breakdown: baseBreakdown, withinBudget: true,
    });
    expect(result.dayPlans).toBe(basePlan.dayPlans);
    expect(result.budgetBreakdown).toBe(baseBreakdown);
    expect(result.budgetRound).toBe(0);
    expect(result._pendingBudgetFeedback).toBeUndefined();
    expect(result.phase).toBe("planning");
  });

  it("over budget + round < MAX: phase reverts to planning, budgetRound++, feedback set", () => {
    const overBreakdown = makeBudget({ totalCost: 20000, budgetLimit: 15000, isWithinBudget: false, variance: 5000 });
    const state = makeState({
      phase: "planning",
      budgetRound: 1,
      preferences: makePrefs(),
    });
    const result = applyFinalizePlan(state, {
      plan: basePlan, breakdown: overBreakdown, withinBudget: false,
    });
    expect(result.budgetRound).toBe(2);
    expect(result.phase).toBe("planning");
    expect(result._pendingBudgetFeedback).toContain("行程预算超出");
    expect(result._pendingBudgetFeedback).toContain("¥20000");
    expect(result._pendingBudgetFeedback).toContain("超 ¥5000");
  });

  it("over budget + round >= MAX: forces completed + records error", () => {
    const overBreakdown = makeBudget({ totalCost: 20000, budgetLimit: 15000, isWithinBudget: false, variance: 5000 });
    const state = makeState({
      phase: "planning",
      budgetRound: MAX_BUDGET_ROUNDS,
      preferences: makePrefs(),
    });
    const result = applyFinalizePlan(state, {
      plan: basePlan, breakdown: overBreakdown, withinBudget: false,
    });
    expect(result.budgetRound).toBe(MAX_BUDGET_ROUNDS);
    expect(result.phase).toBe("completed");
    expect(result._pendingBudgetFeedback).toBeUndefined();
    expect(result.errorMessages.some(e => e.includes("Budget exceeded after"))).toBe(true);
  });
});

describe("applyToolEffects (main reducer)", () => {
  it("returns new state, original unchanged (immutable)", () => {
    const state = makeState();
    const results: ToolResultLike[] = [
      { toolName: "search_baike", success: true, data: { summary: "x" } },
    ];
    const next = applyToolEffects(state, results);
    expect(next).not.toBe(state);
    expect(state.baikeKnowledge).toBeUndefined();
    expect(next.baikeKnowledge).toBe("x");
  });

  it("processes multiple successful results in order", () => {
    const state = makeState();
    const results: ToolResultLike[] = [
      { toolName: "search_attractions", success: true, data: { items: [makeActivity("A1")], scores: { "A1": 0.9 } } },
      { toolName: "search_attractions", success: true, data: { items: [makeActivity("A2")], scores: { "A2": 0.8 } } },
      { toolName: "search_xhs", success: true, data: { notes: [makeNote("n1")] } },
    ];
    const next = applyToolEffects(state, results);
    expect(next.candidateAttractions?.map(a => a.name)).toEqual(["A1", "A2"]);
    expect(next.xhsNotes?.map(n => n.noteId)).toEqual(["n1"]);
  });

  it("records toolErrors + fallbackUsage on failed result", () => {
    const state = makeState();
    const results: ToolResultLike[] = [
      { toolName: "search_xhs", success: false, error: "xhs-service down", fallbackLevel: 1 },
    ];
    const next = applyToolEffects(state, results);
    expect(next.toolErrors["search_xhs"]).toBe("xhs-service down");
    expect(next.fallbackUsage["search_xhs"]).toBe(1);
  });

  it("does NOT increment fallbackUsage when fallbackLevel = 0", () => {
    const state = makeState();
    const results: ToolResultLike[] = [
      { toolName: "search_xhs", success: false, error: "primary source failed at L0", fallbackLevel: 0 },
    ];
    const next = applyToolEffects(state, results);
    expect(next.toolErrors["search_xhs"]).toBe("primary source failed at L0");
    expect(next.fallbackUsage["search_xhs"]).toBeUndefined();
  });

  it("increments fallbackUsage even on successful fallback (L2 success recorded)", () => {
    const state = makeState();
    const results: ToolResultLike[] = [
      { toolName: "search_xhs", success: true, fallbackLevel: 2, data: { notes: [makeNote("n1")] } },
    ];
    const next = applyToolEffects(state, results);
    expect(next.fallbackUsage["search_xhs"]).toBe(1);
    expect(next.xhsNotes?.map(n => n.noteId)).toEqual(["n1"]);
    expect(next.toolErrors["search_xhs"]).toBeUndefined();
  });

  it("unknown toolName (no handler) is silently ignored", () => {
    const state = makeState();
    const results: ToolResultLike[] = [
      { toolName: "nonexistent_tool", success: true, data: { x: 1 } },
    ];
    const next = applyToolEffects(state, results);
    expect(next).toEqual(state);
    expect(next).toBe(state);
  });

  it("mixed batch: success + failure both recorded", () => {
    const state = makeState();
    const results: ToolResultLike[] = [
      { toolName: "search_attractions", success: true, data: { items: [makeActivity("A1")], scores: {} } },
      { toolName: "search_xhs", success: false, error: "rate limited", fallbackLevel: 2 },
      { toolName: "search_baike", success: true, data: { summary: "ok" } },
    ];
    const next = applyToolEffects(state, results);
    expect(next.candidateAttractions?.length).toBe(1);
    expect(next.baikeKnowledge).toBe("ok");
    expect(next.toolErrors["search_xhs"]).toBe("rate limited");
    expect(next.fallbackUsage["search_xhs"]).toBe(1);
  });
});
