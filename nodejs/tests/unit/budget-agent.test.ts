import { describe, it, expect } from "vitest";
import { BudgetAgent } from "../../src/agents/budget-agent.js";
import { TravelStyle, TravelPlanState, type UserPreferences } from "../../src/types/index.js";

const makePref = (overrides: Partial<UserPreferences> = {}): UserPreferences => ({
  budget: 10000, travelStyle: TravelStyle.COMFORT, departureCity: "北京",
  startDate: "2026-06-01", endDate: "2026-06-05", numTravelers: 1,
  interests: [], dietaryRestrictions: [], accessibilityNeeds: [], notes: "",
  transportPreference: "no_preference", departureTime: "flexible", budgetStrictness: "strict",
  accommodationType: "any", preferredHotelBrands: [], localTransitMode: "mixed",
  diningPreference: "mixed", ...overrides,
});

const makeState = (overrides: Partial<UserPreferences> = {}): TravelPlanState => {
  const state = new TravelPlanState();
  state.preferences = makePref(overrides);
  return state;
};

describe("BudgetAgent.isWithinFlexBudget", () => {
  it("strict: within budget passes", () => {
    expect(BudgetAgent.isWithinFlexBudget(makePref({ budgetStrictness: "strict" }), 9500)).toBe(true);
  });

  it("strict: over budget fails", () => {
    expect(BudgetAgent.isWithinFlexBudget(makePref({ budgetStrictness: "strict" }), 10500)).toBe(false);
  });

  it("flexible: 110% passes (limit 115%)", () => {
    expect(BudgetAgent.isWithinFlexBudget(makePref({ budgetStrictness: "flexible", budget: 10000 }), 11000)).toBe(true);
  });

  it("flexible: 120% fails (limit 115%)", () => {
    expect(BudgetAgent.isWithinFlexBudget(makePref({ budgetStrictness: "flexible", budget: 10000 }), 12000)).toBe(false);
  });

  it("luxury: 125% passes (limit 130%)", () => {
    expect(BudgetAgent.isWithinFlexBudget(makePref({ budgetStrictness: "luxury", budget: 10000 }), 12500)).toBe(true);
  });

  it("luxury: 135% fails (limit 130%)", () => {
    expect(BudgetAgent.isWithinFlexBudget(makePref({ budgetStrictness: "luxury", budget: 10000 }), 13500)).toBe(false);
  });
});

describe("BudgetAgent.computeConstraints", () => {
  it("round 1: cuts activity cost, keeps hotel", () => {
    const state = makeState();
    state.adjustmentRound = 1;
    const c = BudgetAgent.computeConstraints(state);
    expect(c.maxActivityCostPerDay).toBeDefined();
    expect(c.maxActivityCostPerDay!).toBeLessThan(10000 * 0.3 / 4);
    expect(c.maxHotelPricePerNight).toBeDefined();
    expect(c.maxFlightPricePerPerson).toBeUndefined();
  });

  it("round 2: cuts hotel + star rating", () => {
    const state = makeState();
    state.adjustmentRound = 2;
    const c = BudgetAgent.computeConstraints(state);
    expect(c.maxHotelStarRating).toBe(3.5);
    expect(c.preferredCabinClass).toBe("economy");
    expect(c.maxHotelPricePerNight).toBeDefined();
  });

  it("round 3+: cuts all + train fallback", () => {
    const state = makeState();
    state.adjustmentRound = 3;
    const c = BudgetAgent.computeConstraints(state);
    expect(c.maxFlightPricePerPerson).toBeDefined();
    expect(c.maxHotelStarRating).toBe(3.0);
    expect(c.allowTrainFallback).toBe(true);
  });
});

describe("BudgetAgent.generateSuggestions", () => {
  it("round 0: suggests free attractions", () => {
    const s = BudgetAgent.generateSuggestions(500, 3000, 4000, 2500, 0);
    expect(s.some(t => t.includes("免费景点"))).toBe(true);
  });

  it("round 1: suggests lowering star rating", () => {
    const s = BudgetAgent.generateSuggestions(300, 2000, 3000, 1500, 1);
    expect(s.some(t => t.includes("3.5"))).toBe(true);
  });

  it("round 2+: suggests economy and train", () => {
    const s = BudgetAgent.generateSuggestions(200, 1000, 2000, 1000, 2);
    expect(s.some(t => t.includes("高铁") || t.includes("经济舱"))).toBe(true);
  });
});
