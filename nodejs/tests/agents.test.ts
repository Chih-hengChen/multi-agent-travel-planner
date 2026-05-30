import { describe, it, expect } from "vitest";
import {
  PlanningState,
  TravelPlanState,
  TravelStyle,
  type UserPreferences,
} from "../src/types/index.js";
import {
  PreferenceAgent,
  DestinationAgent,
  FlightAgent,
  HotelAgent,
  ActivityAgent,
} from "../src/agents/index.js";
import { quickPlan } from "../src/orchestrator/pipeline.js";
import pino from "pino";

const logger = pino({ level: "silent" });

function makePrefs(overrides: Partial<UserPreferences> = {}): UserPreferences {
  return {
    budget: 10000,
    travelStyle: TravelStyle.COMFORT,
    departureCity: "北京",
    startDate: "2026-05-01",
    endDate: "2026-05-05",
    numTravelers: 1,
    interests: [],
    dietaryRestrictions: [],
    accessibilityNeeds: [],
    notes: "",
    ...overrides,
  };
}

function makeState(overrides: Partial<UserPreferences> = {}): TravelPlanState {
  const state = new TravelPlanState();
  state.preferences = makePrefs(overrides);
  return state;
}

// ━━━━━━ Preference Agent ━━━━━━

describe("PreferenceAgent", () => {
  it("fills interests when empty", async () => {
    const state = makeState();
    const agent = new PreferenceAgent(logger);
    const result = await agent.run(state);
    expect(result.preferences).not.toBeNull();
    expect(result.preferences!.interests.length).toBeGreaterThan(0);
    expect(result.state).toBe(PlanningState.RECOMMENDING_DESTINATIONS);
  });

  it("keeps existing interests", async () => {
    const state = makeState();
    state.preferences!.interests = ["自定义兴趣"];
    const agent = new PreferenceAgent(logger);
    const result = await agent.run(state);
    expect(result.preferences!.interests).toEqual(["自定义兴趣"]);
  });
});

// ━━━━━━ Destination Agent ━━━━━━

describe("DestinationAgent", () => {
  it("recommends a destination", async () => {
    const state = makeState();
    state.state = PlanningState.RECOMMENDING_DESTINATIONS;
    const agent = new DestinationAgent(logger);
    const result = await agent.run(state);
    expect(result.destinationRec).not.toBeNull();
    expect(result.destinationRec!.selected).not.toBeNull();
    expect(result.destinationRec!.destinations.length).toBeGreaterThanOrEqual(1);
    expect(result.state).toBe(PlanningState.SEARCHING_PARALLEL);
  });
});

// ━━━━━━ Flight Agent ━━━━━━

describe("FlightAgent", () => {
  it("searches flights", async () => {
    let state = makeState();
    const destAgent = new DestinationAgent(logger);
    state = await destAgent.run(state);

    const agent = new FlightAgent(logger);
    const result = await agent.run(state);
    expect(result.flightResult).not.toBeNull();
    expect(result.flightResult!.outboundFlights.length).toBeGreaterThan(0);
    expect(result.flightResult!.recommendedOutbound).not.toBeNull();
    expect(result.flightResult!.totalFlightCost).toBeGreaterThan(0);
  });
});

// ━━━━━━ Hotel Agent ━━━━━━

describe("HotelAgent", () => {
  it("searches hotels", async () => {
    let state = makeState();
    const destAgent = new DestinationAgent(logger);
    state = await destAgent.run(state);

    const agent = new HotelAgent(logger);
    const result = await agent.run(state);
    expect(result.hotelResult).not.toBeNull();
    expect(result.hotelResult!.hotels.length).toBeGreaterThan(0);
    expect(result.hotelResult!.recommended).not.toBeNull();
  });
});

// ━━━━━━ Activity Agent ━━━━━━

describe("ActivityAgent", () => {
  it("generates day plans", async () => {
    let state = makeState();
    const destAgent = new DestinationAgent(logger);
    state = await destAgent.run(state);

    const agent = new ActivityAgent(logger);
    const result = await agent.run(state);
    expect(result.activityResult).not.toBeNull();
    expect(result.activityResult!.dayPlans.length).toBeGreaterThan(0);
  });
});

// ━━━━━━ Budget Agent ━━━━━━

describe("BudgetAgent via pipeline", () => {
  it("passes with high budget", async () => {
    const state = await quickPlan({ budget: 50000 });
    expect(state.budgetBreakdown).not.toBeNull();
    expect(state.budgetBreakdown!.isWithinBudget).toBe(true);
  });

  it("triggers adjustment with low budget", async () => {
    const state = await quickPlan({ budget: 2000, travelers: 2 });
    expect(state.adjustmentRound).toBeGreaterThan(0);
  });
});

// ━━━━━━ Full Pipeline ━━━━━━

describe("Full Pipeline", () => {
  it("completes end-to-end", async () => {
    const state = await quickPlan({
      budget: 15000,
      departure: "上海",
      start: "2026-06-01",
      end: "2026-06-05",
    });
    expect(state.state).toBe(PlanningState.COMPLETED);
    expect(state.selectedDestination).not.toBeNull();
    expect(state.flightResult).not.toBeNull();
    expect(state.hotelResult).not.toBeNull();
    expect(state.activityResult).not.toBeNull();
    expect(state.budgetBreakdown).not.toBeNull();
  });

  it("handles multiple travel styles", async () => {
    for (const style of ["budget", "comfort", "luxury", "adventure"]) {
      const state = await quickPlan({ budget: 20000, style });
      expect(state.state).toBe(PlanningState.COMPLETED);
    }
  });
});
