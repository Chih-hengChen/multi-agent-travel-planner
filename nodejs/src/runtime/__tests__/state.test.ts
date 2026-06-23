import { describe, it, expect } from "vitest";
import {
  type AgentState,
  MAX_BUDGET_ROUNDS,
  createInitialAgentState,
  computeTravelDays,
  isPreferencesComplete,
  maybeAdvancePhase,
  canFinish,
  getMissingRequirements,
} from "../state.js";
import type { UserPreferences } from "../../types/index.js";
import type { TransportOption } from "../../conversation/context.js";

function makePrefs(overrides: Partial<UserPreferences> = {}): UserPreferences {
  return {
    budget: 15000,
    travelStyle: "comfort" as any,
    departureCity: "北京",
    startDate: "2026-07-01",
    endDate: "2026-07-05",
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
    ...overrides,
  } as UserPreferences;
}

function makeTransport(id: string): TransportOption {
  return {
    id,
    mode: "flight",
    flightNo: id,
    departStation: "北京",
    arriveStation: "东京",
    departTime: "08:00",
    arriveTime: "12:00",
    duration: "4h",
    price: 3000,
    isRecommended: false,
  };
}

function makeHotel(name: string): any {
  return { name, city: "东京", address: "", starRating: 4, userRating: 8.5, pricePerNight: 800, amenities: [], distanceToCenterKm: 2 };
}

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return { ...createInitialAgentState(), ...overrides };
}

describe("createInitialAgentState", () => {
  it("returns gathering phase with empty metadata", () => {
    const s = createInitialAgentState();
    expect(s.phase).toBe("gathering");
    expect(s.iteration).toBe(0);
    expect(s.budgetRound).toBe(0);
    expect(s.priceWarnings).toEqual([]);
    expect(s.errorMessages).toEqual([]);
    expect(s.toolErrors).toEqual({});
    expect(s.rerankScores).toEqual({});
    expect(s.fallbackUsage).toEqual({});
    expect(s.preferences).toBeUndefined();
  });
});

describe("computeTravelDays", () => {
  it("July 1-5 = 5 calendar days", () => {
    expect(computeTravelDays(makePrefs({ startDate: "2026-07-01", endDate: "2026-07-05" }))).toBe(5);
  });

  it("same-day trip = 1 day (min)", () => {
    expect(computeTravelDays(makePrefs({ startDate: "2026-07-01", endDate: "2026-07-01" }))).toBe(1);
  });

  it("reversed dates = 1 day (guard)", () => {
    expect(computeTravelDays(makePrefs({ startDate: "2026-07-05", endDate: "2026-07-01" }))).toBe(1);
  });

  it("invalid dates = 1 day (NaN guard)", () => {
    expect(computeTravelDays(makePrefs({ startDate: "not-a-date", endDate: "also-bad" } as any))).toBe(1);
  });
});

describe("isPreferencesComplete", () => {
  it("undefined prefs = false", () => {
    expect(isPreferencesComplete(undefined)).toBe(false);
  });

  it("missing destination = false", () => {
    expect(isPreferencesComplete(makePrefs({ preferredDestination: undefined } as any))).toBe(false);
  });

  it("missing departureCity = false", () => {
    expect(isPreferencesComplete(makePrefs({ departureCity: "" } as any))).toBe(false);
  });

  it("all required fields present = true", () => {
    expect(isPreferencesComplete(makePrefs())).toBe(true);
  });
});

describe("maybeAdvancePhase", () => {
  it("gathering -> gathering when prefs incomplete", () => {
    const s = makeState({ phase: "gathering", preferences: undefined });
    expect(maybeAdvancePhase(s).phase).toBe("gathering");
  });

  it("gathering -> searching when prefs complete", () => {
    const s = makeState({ phase: "gathering", preferences: makePrefs() });
    expect(maybeAdvancePhase(s).phase).toBe("searching");
  });

  it("searching -> searching when no candidates", () => {
    const s = makeState({ phase: "searching", preferences: makePrefs() });
    expect(maybeAdvancePhase(s).phase).toBe("searching");
  });

  it("searching -> searching when only transport", () => {
    const s = makeState({
      phase: "searching",
      preferences: makePrefs(),
      candidateTransports: [makeTransport("CA123")],
    });
    expect(maybeAdvancePhase(s).phase).toBe("searching");
  });

  it("searching -> selecting when transport + hotels both non-empty", () => {
    const s = makeState({
      phase: "searching",
      preferences: makePrefs(),
      candidateTransports: [makeTransport("CA123")],
      candidateHotels: [makeHotel("H1")],
    });
    expect(maybeAdvancePhase(s).phase).toBe("selecting");
  });

  it("selecting -> selecting when missing return", () => {
    const s = makeState({
      phase: "selecting",
      preferences: makePrefs(),
      selectedOutbound: makeTransport("CA123"),
      selectedHotel: makeHotel("H1"),
    });
    expect(maybeAdvancePhase(s).phase).toBe("selecting");
  });

  it("selecting -> planning when all 3 selected", () => {
    const s = makeState({
      phase: "selecting",
      preferences: makePrefs(),
      selectedOutbound: makeTransport("CA-out"),
      selectedReturn: makeTransport("CA-ret"),
      selectedHotel: makeHotel("H1"),
    });
    expect(maybeAdvancePhase(s).phase).toBe("planning");
  });

  it("planning -> planning when days incomplete", () => {
    const s = makeState({
      phase: "planning",
      preferences: makePrefs(),
      dayPlans: [{ dayIdx: 0, date: "2026-07-01", dining: [], transitTips: [] } as any],
      budgetBreakdown: { totalCost: 100, byCategory: { transport: 0, accommodation: 0, food: 0, attractions: 0, other: 0 }, budgetLimit: 15000, isWithinBudget: true, variance: 0 },
    });
    expect(maybeAdvancePhase(s).phase).toBe("planning");
  });

  it("planning -> completed when days match + within budget", () => {
    const s = makeState({
      phase: "planning",
      preferences: makePrefs({ startDate: "2026-07-01", endDate: "2026-07-02" }),
      dayPlans: [
        { dayIdx: 0, date: "2026-07-01", dining: [], transitTips: [] } as any,
        { dayIdx: 1, date: "2026-07-02", dining: [], transitTips: [] } as any,
      ],
      budgetBreakdown: { totalCost: 100, byCategory: { transport: 0, accommodation: 0, food: 0, attractions: 0, other: 0 }, budgetLimit: 15000, isWithinBudget: true, variance: 0 },
    });
    expect(maybeAdvancePhase(s).phase).toBe("completed");
  });

  it("planning -> planning when within budget but lastThought has 继续信号", () => {
    const s = makeState({
      phase: "planning",
      preferences: makePrefs({ startDate: "2026-07-01", endDate: "2026-07-02" }),
      dayPlans: [
        { dayIdx: 0, date: "2026-07-01", dining: [], transitTips: [] } as any,
        { dayIdx: 1, date: "2026-07-02", dining: [], transitTips: [] } as any,
      ],
      budgetBreakdown: { totalCost: 100, byCategory: { transport: 0, accommodation: 0, food: 0, attractions: 0, other: 0 }, budgetLimit: 15000, isWithinBudget: true, variance: 0 },
      lastThought: "还需要继续细化行程",
    });
    expect(maybeAdvancePhase(s).phase).toBe("planning");
  });

  it("planning -> planning when over budget + budgetRound < MAX", () => {
    const s = makeState({
      phase: "planning",
      budgetRound: 1,
      preferences: makePrefs({ startDate: "2026-07-01", endDate: "2026-07-02" }),
      dayPlans: [{ dayIdx: 0, date: "2026-07-01", dining: [], transitTips: [] } as any],
      budgetBreakdown: { totalCost: 20000, byCategory: { transport: 0, accommodation: 0, food: 0, attractions: 0, other: 0 }, budgetLimit: 15000, isWithinBudget: false, variance: 5000 },
    });
    expect(maybeAdvancePhase(s).phase).toBe("planning");
  });

  it("planning -> completed when over budget + budgetRound >= MAX", () => {
    const s = makeState({
      phase: "planning",
      budgetRound: MAX_BUDGET_ROUNDS,
      preferences: makePrefs({ startDate: "2026-07-01", endDate: "2026-07-02" }),
      dayPlans: [
        { dayIdx: 0, date: "2026-07-01", dining: [], transitTips: [] } as any,
        { dayIdx: 1, date: "2026-07-02", dining: [], transitTips: [] } as any,
      ],
      budgetBreakdown: { totalCost: 20000, byCategory: { transport: 0, accommodation: 0, food: 0, attractions: 0, other: 0 }, budgetLimit: 15000, isWithinBudget: false, variance: 5000 },
    });
    expect(maybeAdvancePhase(s).phase).toBe("completed");
  });

  it("completed -> completed (no transition)", () => {
    const s = makeState({ phase: "completed" });
    expect(maybeAdvancePhase(s).phase).toBe("completed");
  });

  it("returns new object (immutable)", () => {
    const s = makeState({ phase: "gathering", preferences: makePrefs() });
    const next = maybeAdvancePhase(s);
    expect(next).not.toBe(s);
    expect(s.phase).toBe("gathering");
    expect(next.phase).toBe("searching");
  });
});

describe("canFinish", () => {
  const baseCompleted: AgentState = {
    ...createInitialAgentState(),
    phase: "completed",
    preferences: makePrefs({ startDate: "2026-07-01", endDate: "2026-07-03" }),
    dayPlans: [
      { dayIdx: 0, date: "2026-07-01", dining: [], transitTips: [] } as any,
      { dayIdx: 1, date: "2026-07-02", dining: [], transitTips: [] } as any,
      { dayIdx: 2, date: "2026-07-03", dining: [], transitTips: [] } as any,
    ],
    budgetBreakdown: { totalCost: 100, byCategory: { transport: 0, accommodation: 0, food: 0, attractions: 0, other: 0 }, budgetLimit: 15000, isWithinBudget: true, variance: 0 },
  };

  it("returns true when all conditions met", () => {
    expect(canFinish(baseCompleted)).toBe(true);
  });

  it("returns false when phase != completed", () => {
    expect(canFinish({ ...baseCompleted, phase: "planning" })).toBe(false);
  });

  it("returns false when phase = gathering", () => {
    expect(canFinish({ ...baseCompleted, phase: "gathering" })).toBe(false);
  });

  it("returns false when phase = searching", () => {
    expect(canFinish({ ...baseCompleted, phase: "searching" })).toBe(false);
  });

  it("returns false when phase = selecting", () => {
    expect(canFinish({ ...baseCompleted, phase: "selecting" })).toBe(false);
  });

  it("returns false when dayPlans missing", () => {
    expect(canFinish({ ...baseCompleted, dayPlans: undefined })).toBe(false);
  });

  it("returns false when dayPlans wrong count (too few)", () => {
    expect(canFinish({ ...baseCompleted, dayPlans: [baseCompleted.dayPlans![0]] })).toBe(false);
  });

  it("returns false when dayPlans wrong count (too many)", () => {
    expect(canFinish({
      ...baseCompleted,
      dayPlans: [...baseCompleted.dayPlans!, { dayIdx: 99, date: "x", dining: [], transitTips: [] } as any],
    })).toBe(false);
  });

  it("returns false when budgetBreakdown missing", () => {
    expect(canFinish({ ...baseCompleted, budgetBreakdown: undefined })).toBe(false);
  });

  it("returns false when preferences missing", () => {
    expect(canFinish({ ...baseCompleted, preferences: undefined })).toBe(false);
  });

  it("returns true even if lastThought has 继续信号 (completed phase)", () => {
    expect(canFinish({ ...baseCompleted, lastThought: "还需要继续" })).toBe(true);
  });

  it("returns false when phase completed but dayPlans empty + no budget", () => {
    expect(canFinish({ ...baseCompleted, dayPlans: undefined, budgetBreakdown: undefined })).toBe(false);
  });

  it("returns false when preferences undefined + dayPlans empty even if budget exists (regression)", () => {
    expect(canFinish({
      ...baseCompleted,
      preferences: undefined,
      dayPlans: undefined,
    })).toBe(false);
  });
});

describe("getMissingRequirements", () => {
  it("gathering with no prefs returns preferences (全部)", () => {
    const s = makeState({ phase: "gathering" });
    expect(getMissingRequirements(s)).toEqual(["preferences (全部)"]);
  });

  it("gathering with partial prefs lists specific missing", () => {
    const s = makeState({
      phase: "gathering",
      preferences: makePrefs({ departureCity: "", preferredDestination: "东京" } as any),
    });
    const missing = getMissingRequirements(s);
    expect(missing).toContain("departureCity");
    expect(missing).not.toContain("destination");
  });

  it("searching lists all 3 search outputs when empty", () => {
    const s = makeState({ phase: "searching", preferences: makePrefs() });
    const missing = getMissingRequirements(s);
    expect(missing).toContain("candidateTransports (search_flights/trains)");
    expect(missing).toContain("candidateHotels (search_hotels)");
    expect(missing).toContain("baikeKnowledge (search_baike)");
  });

  it("selecting lists missing selections", () => {
    const s = makeState({
      phase: "selecting",
      preferences: makePrefs(),
      selectedOutbound: makeTransport("X"),
    });
    const missing = getMissingRequirements(s);
    expect(missing).toContain("selectedReturn");
    expect(missing).toContain("selectedHotel");
    expect(missing).not.toContain("selectedOutbound");
  });

  it("planning lists dayPlans shortage count", () => {
    const s = makeState({
      phase: "planning",
      preferences: makePrefs({ startDate: "2026-07-01", endDate: "2026-07-05" }),
      dayPlans: [{ dayIdx: 0, date: "x", dining: [], transitTips: [] } as any],
    });
    const missing = getMissingRequirements(s);
    expect(missing.some(m => m.startsWith("dayPlans (need 5, have 1)"))).toBe(true);
    expect(missing).toContain("budgetBreakdown");
  });

  it("completed returns empty", () => {
    const s = makeState({ phase: "completed" });
    expect(getMissingRequirements(s)).toEqual([]);
  });
});
