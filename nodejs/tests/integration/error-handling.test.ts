import { describe, it, expect } from "vitest";
import pino from "pino";
import { PlanningState, TravelPlanState, type Destination } from "../../src/types/index.js";
import { FlightAgent } from "../../src/agents/flight-agent.js";
import { HotelAgent } from "../../src/agents/hotel-agent.js";
import { ActivityAgent } from "../../src/agents/activity-agent.js";
import { BudgetAgent } from "../../src/agents/budget-agent.js";
import { ParallelExecutor } from "../../src/orchestrator/parallel.js";
import { BudgetLoopController } from "../../src/orchestrator/budget-loop.js";
import { FallbackDataSource } from "../../src/data-sources/fallback-data-source.js";
import { createTestDataSource, createFailingDataSource } from "../fixtures/deterministic-data-source.js";
import { BEIJING_BUDGET_HOTELS, BEIJING_BUDGET_ATTRACTIONS, BEIJING_BUDGET_RESTAURANTS, SHANGHAI_BEIJING_TRAINS, SHANGHAI_BEIJING_RETURN_TRAINS } from "../fixtures/test-data.js";

const log = pino({ level: "silent" });

function setDestination(state: TravelPlanState, city: string): TravelPlanState {
  const dest: Destination = { city, country: "中国", description: "", bestSeason: "", visaRequired: false, safetyScore: 8, costLevel: "medium", highlights: [] };
  state.destinationRec = { destinations: [dest], selected: dest, reasoning: "" };
  state.state = PlanningState.SEARCHING_PARALLEL;
  return state;
}

function makePrefs() {
  return {
    budget: 5000, travelStyle: "comfort" as const, departureCity: "上海",
    startDate: "2026-06-01", endDate: "2026-06-05", numTravelers: 1,
    interests: [], dietaryRestrictions: [], accessibilityNeeds: [], notes: "",
    transportPreference: "high_speed_rail" as const, departureTime: "flexible" as const,
    budgetStrictness: "strict" as const, accommodationType: "any" as const,
    preferredHotelBrands: [], localTransitMode: "mixed" as const, diningPreference: "mixed" as const,
  };
}

describe("Agent error handling", () => {
  it("pipeline survives data source throwing on searchFlights", async () => {
    const state = setDestination(new TravelPlanState(), "北京");
    state.preferences = makePrefs();

    const ds = createFailingDataSource({ searchFlights: new Error("API timeout") });
    const goodDs = createTestDataSource({
      trains: SHANGHAI_BEIJING_TRAINS,
      returnTrains: SHANGHAI_BEIJING_RETURN_TRAINS,
      hotels: BEIJING_BUDGET_HOTELS,
      attractions: BEIJING_BUDGET_ATTRACTIONS,
      restaurants: BEIJING_BUDGET_RESTAURANTS,
    });

    const flightAgent = new FlightAgent(log, ds);
    const hotelAgent = new HotelAgent(log, goodDs);
    const activityAgent = new ActivityAgent(log, goodDs);
    const budgetAgent = new BudgetAgent(log, goodDs);
    const parallel = new ParallelExecutor([flightAgent, hotelAgent, activityAgent], log);
    const loop = new BudgetLoopController(parallel, budgetAgent, log, 3);

    const result = await loop.run(state);
    expect(result.state).toBe(PlanningState.COMPLETED);
  });

  it("pipeline survives all data sources failing", async () => {
    const state = setDestination(new TravelPlanState(), "北京");
    state.preferences = makePrefs();

    const ds = createFailingDataSource({
      searchFlights: new Error("fail"),
      searchHotels: new Error("fail"),
      searchAttractions: new Error("fail"),
      searchTrains: new Error("fail"),
      searchRestaurants: new Error("fail"),
    });

    const flightAgent = new FlightAgent(log, ds);
    const hotelAgent = new HotelAgent(log, ds);
    const activityAgent = new ActivityAgent(log, ds);
    const budgetAgent = new BudgetAgent(log, ds);
    const parallel = new ParallelExecutor([flightAgent, hotelAgent, activityAgent], log);
    const loop = new BudgetLoopController(parallel, budgetAgent, log, 3);

    const result = await loop.run(state);
    expect(result.state).toBe(PlanningState.COMPLETED);
    expect(result.budgetBreakdown).not.toBeNull();
    expect(result.budgetBreakdown!.totalCost).toBe(0);
    expect(result.budgetBreakdown!.isWithinBudget).toBe(true);
  });
});

describe("FallbackDataSource", () => {
  it("falls back to secondary when primary returns empty", async () => {
    const emptyPrimary = createTestDataSource({ flights: [], hotels: [], trains: [], attractions: [], restaurants: [] });
    const fullSecondary = createTestDataSource({
      flights: [{ airline: "测试", flightNo: "T1", departureCity: "上海", arrivalCity: "北京", departureTime: "08:00", arrivalTime: "10:30", price: 800, durationHours: 2.5, stops: 0, cabinClass: "economy" }],
      hotels: BEIJING_BUDGET_HOTELS,
      trains: SHANGHAI_BEIJING_TRAINS,
      attractions: BEIJING_BUDGET_ATTRACTIONS,
      restaurants: BEIJING_BUDGET_RESTAURANTS,
    });

    const fallback = new FallbackDataSource(emptyPrimary, fullSecondary, log);
    const flights = await fallback.searchFlights({ origin: "上海", destination: "北京", departureDate: "2026-06-01", adults: 1 });
    expect(flights.length).toBeGreaterThan(0);
  });

  it("falls back to secondary when primary throws", async () => {
    const failingPrimary = createFailingDataSource({ searchHotels: new Error("crash") });
    const fullSecondary = createTestDataSource({ hotels: BEIJING_BUDGET_HOTELS });

    const fallback = new FallbackDataSource(failingPrimary, fullSecondary, log);
    const hotels = await fallback.searchHotels({ city: "北京", checkIn: "2026-06-01", checkOut: "2026-06-05", adults: 1 });
    expect(hotels.length).toBeGreaterThan(0);
  });

  it("returns empty when both sources fail", async () => {
    const failingPrimary = createFailingDataSource({ searchTrains: new Error("crash") });
    const failingSecondary = createFailingDataSource({ searchTrains: new Error("also crash") });

    const fallback = new FallbackDataSource(failingPrimary, failingSecondary, log);
    const trains = await fallback.searchTrains({ from: "上海", to: "北京", date: "2026-06-01" });
    expect(trains).toEqual([]);
  });
});
