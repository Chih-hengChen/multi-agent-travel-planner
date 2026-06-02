import { describe, it, expect } from "vitest";
import pino from "pino";
import { PlanningState, TravelPlanState, type Destination } from "../../src/types/index.js";
import { FlightAgent } from "../../src/agents/flight-agent.js";
import { HotelAgent } from "../../src/agents/hotel-agent.js";
import { ActivityAgent } from "../../src/agents/activity-agent.js";
import { BudgetAgent } from "../../src/agents/budget-agent.js";
import { ParallelExecutor } from "../../src/orchestrator/parallel.js";
import { BudgetLoopController } from "../../src/orchestrator/budget-loop.js";
import { createTestDataSource } from "../fixtures/deterministic-data-source.js";
import { budgetWeekendPrefs, businessLuxuryPrefs, railBnbPrefs, noTransitPrefs } from "../fixtures/test-preferences.js";
import {
  SHANGHAI_BEIJING_FLIGHTS, SHANGHAI_BEIJING_RETURN_FLIGHTS,
  SHANGHAI_BEIJING_TRAINS, SHANGHAI_BEIJING_RETURN_TRAINS,
  BEIJING_BUDGET_HOTELS, BEIJING_BUDGET_ATTRACTIONS, BEIJING_BUDGET_RESTAURANTS,
  GUANGZHOU_CHENGDU_FLIGHTS, GUANGZHOU_CHENGDU_RETURN_FLIGHTS,
  CHENGDU_LUXURY_HOTELS, CHENGDU_LUXURY_ATTRACTIONS, CHENGDU_LUXURY_RESTAURANTS,
  WUHAN_JINGDEZHEN_TRAINS, JINGDEZHEN_WUHAN_TRAINS,
  JINGDEZHEN_HOTELS, JINGDEZHEN_ATTRACTIONS, JINGDEZHEN_RESTAURANTS,
  DALI_TENGCHONG_HOTELS, DALI_TENGCHONG_ATTRACTIONS, DALI_TENGCHONG_RESTAURANTS,
} from "../fixtures/test-data.js";

const log = pino({ level: "silent" });

function setDestination(state: TravelPlanState, city: string): TravelPlanState {
  const dest: Destination = { city, country: "中国", description: "", bestSeason: "", visaRequired: false, safetyScore: 8, costLevel: "medium", highlights: [] };
  state.destinationRec = { destinations: [dest], selected: dest, reasoning: "" };
  state.state = PlanningState.SEARCHING_PARALLEL;
  return state;
}

function runBudgetLoop(state: TravelPlanState, ds: ReturnType<typeof createTestDataSource>): Promise<TravelPlanState> {
  const flightAgent = new FlightAgent(log, ds);
  const hotelAgent = new HotelAgent(log, ds);
  const activityAgent = new ActivityAgent(log, ds);
  const budgetAgent = new BudgetAgent(log, ds);
  const parallel = new ParallelExecutor([flightAgent, hotelAgent, activityAgent], log);
  const loop = new BudgetLoopController(parallel, budgetAgent, log, 3);
  return loop.run(state);
}

describe("Scenario 1.1: 预算周末 上海→北京", () => {
  it("prefers train when budget is tight", async () => {
    const prefs = budgetWeekendPrefs();
    const state = setDestination(new TravelPlanState(), "北京");
    state.preferences = prefs;

    const ds = createTestDataSource({
      flights: SHANGHAI_BEIJING_FLIGHTS,
      returnFlights: SHANGHAI_BEIJING_RETURN_FLIGHTS,
      trains: SHANGHAI_BEIJING_TRAINS,
      returnTrains: SHANGHAI_BEIJING_RETURN_TRAINS,
      hotels: BEIJING_BUDGET_HOTELS,
      attractions: BEIJING_BUDGET_ATTRACTIONS,
      restaurants: BEIJING_BUDGET_RESTAURANTS,
    });

    const result = await runBudgetLoop(state, ds);

    expect(result.state).toBe(PlanningState.COMPLETED);
    expect(result.transportMode).toBe("train");
    expect(result.budgetBreakdown).not.toBeNull();
    expect(result.trainOutbound).not.toBeNull();
    expect(result.trainReturn).not.toBeNull();
  });

  it("selects budget hotel", async () => {
    const prefs = budgetWeekendPrefs();
    const state = setDestination(new TravelPlanState(), "北京");
    state.preferences = prefs;

    const ds = createTestDataSource({
      flights: SHANGHAI_BEIJING_FLIGHTS,
      returnFlights: SHANGHAI_BEIJING_RETURN_FLIGHTS,
      trains: SHANGHAI_BEIJING_TRAINS,
      returnTrains: SHANGHAI_BEIJING_RETURN_TRAINS,
      hotels: BEIJING_BUDGET_HOTELS,
      attractions: BEIJING_BUDGET_ATTRACTIONS,
      restaurants: BEIJING_BUDGET_RESTAURANTS,
    });

    const result = await runBudgetLoop(state, ds);
    expect(result.hotelResult).not.toBeNull();
    expect(result.hotelResult!.recommended).not.toBeNull();
    expect(result.hotelResult!.recommended!.pricePerNight).toBeLessThan(300);
  });
});

describe("Scenario 1.2: 商务豪华 广州→成都", () => {
  it("completes without budget adjustment", async () => {
    const prefs = businessLuxuryPrefs();
    const state = setDestination(new TravelPlanState(), "成都");
    state.preferences = prefs;

    const ds = createTestDataSource({
      flights: GUANGZHOU_CHENGDU_FLIGHTS,
      returnFlights: GUANGZHOU_CHENGDU_RETURN_FLIGHTS,
      trains: [],
      hotels: CHENGDU_LUXURY_HOTELS,
      attractions: CHENGDU_LUXURY_ATTRACTIONS,
      restaurants: CHENGDU_LUXURY_RESTAURANTS,
    });

    const result = await runBudgetLoop(state, ds);

    expect(result.state).toBe(PlanningState.COMPLETED);
    expect(result.adjustmentRound).toBe(0);
    expect(result.hotelResult!.recommended!.starRating).toBeGreaterThanOrEqual(4.0);
    expect(result.budgetBreakdown!.totalCost).toBeLessThanOrEqual(8000 * 1.3);
  });
});

describe("Scenario 2.1: 高铁民宿 武汉→景德镇", () => {
  it("uses train with high_speed_rail preference", async () => {
    const prefs = railBnbPrefs();
    const state = setDestination(new TravelPlanState(), "景德镇");
    state.preferences = prefs;

    const ds = createTestDataSource({
      flights: [],
      returnFlights: [],
      trains: WUHAN_JINGDEZHEN_TRAINS,
      returnTrains: JINGDEZHEN_WUHAN_TRAINS,
      hotels: JINGDEZHEN_HOTELS,
      attractions: JINGDEZHEN_ATTRACTIONS,
      restaurants: JINGDEZHEN_RESTAURANTS,
    });

    const result = await runBudgetLoop(state, ds);

    expect(result.state).toBe(PlanningState.COMPLETED);
    expect(result.transportMode).toBe("train");
    expect(result.trainOutbound).not.toBeNull();
    expect(result.trainReturn).not.toBeNull();
    expect(result.flightResult!.totalFlightCost).toBe(0);
    expect(result.hotelResult!.recommended).not.toBeNull();
  });
});

describe("Scenario 3.1: 无轨交 大理→腾冲", () => {
  it("completes with no transport available", async () => {
    const prefs = noTransitPrefs();
    const state = setDestination(new TravelPlanState(), "腾冲");
    state.preferences = prefs;

    const ds = createTestDataSource({
      flights: [],
      returnFlights: [],
      trains: [],
      returnTrains: [],
      hotels: DALI_TENGCHONG_HOTELS,
      attractions: DALI_TENGCHONG_ATTRACTIONS,
      restaurants: DALI_TENGCHONG_RESTAURANTS,
    });

    const result = await runBudgetLoop(state, ds);

    expect(result.state).toBe(PlanningState.COMPLETED);
    expect(result.hotelResult).not.toBeNull();
    expect(result.hotelResult!.recommended).not.toBeNull();
    expect(result.activityResult).not.toBeNull();
    expect(result.activityResult!.dayPlans.length).toBeGreaterThanOrEqual(1);
  });
});

describe.skip("Scenario 4.1: 青甘大环线 (需 RoutingAgent 支持)", () => {
  it("should plan a road trip loop", async () => {
    // 当前架构不支持多目的地滚动锚点，需要 RoutingAgent
    // 参考 tests/travel-agent-test-suite.md 用例 4.1
  });
});
