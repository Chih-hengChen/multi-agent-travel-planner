import pino, { type Logger } from "pino";
import { TravelStyle, TravelPlanState, PlanningState, type UserPreferences } from "../types/index.js";
import { PreferenceAgent, DestinationAgent, FlightAgent, HotelAgent, ActivityAgent, LLMPlanAgent, BudgetAgent } from "../agents/index.js";
import { AmadeusSource } from "../data-sources/amadeus-source.js";
import { BookingSource } from "../data-sources/booking-source.js";
import { AmapSource } from "../data-sources/amap-source.js";
import { WebSearchSource } from "../data-sources/web-search-source.js";
import { Train12306Source } from "../data-sources/train12306-source.js";
import { FallbackDataSource } from "../data-sources/fallback-data-source.js";
import type { TravelDataSource } from "../data-sources/types.js";
import { ParallelExecutor } from "./parallel.js";
import { BudgetLoopController } from "./budget-loop.js";
import { sessionLogger } from "../logging/session-logger.js";

class CompositeDataSource implements TravelDataSource {
  constructor(
    private readonly flights: TravelDataSource,
    private readonly hotels: TravelDataSource,
    private readonly attractions: TravelDataSource,
    private readonly trains: TravelDataSource,
  ) {}

  searchFlights(params: Parameters<TravelDataSource["searchFlights"]>[0]) {
    return this.flights.searchFlights(params);
  }
  searchHotels(params: Parameters<TravelDataSource["searchHotels"]>[0]) {
    return this.hotels.searchHotels(params);
  }
  searchAttractions(params: Parameters<TravelDataSource["searchAttractions"]>[0]) {
    return this.attractions.searchAttractions(params);
  }
  searchTrains(params: Parameters<TravelDataSource["searchTrains"]>[0]) {
    return this.trains.searchTrains(params);
  }
  searchRestaurants(params: Parameters<TravelDataSource["searchRestaurants"]>[0]) {
    return this.attractions.searchRestaurants(params);
  }
  planTransitRoute(origin: import("../types/index.js").GeoLocation, destination: import("../types/index.js").GeoLocation, city: string) {
    return this.attractions.planTransitRoute?.(origin, destination, city) ?? Promise.resolve(null);
  }
}

export class TravelPlanningPipeline {
  private readonly prefAgent: PreferenceAgent;
  private readonly destAgent: DestinationAgent;
  private readonly budgetLoop: BudgetLoopController;
  private readonly activityAgent: ActivityAgent;
  private readonly llmPlanAgent: LLMPlanAgent;
  private readonly log: Logger;

  constructor(log?: Logger) {
    this.log = log ?? pino({ level: "info" });
    const webSearch = new WebSearchSource(this.log);
    const dataSource = new CompositeDataSource(
      new FallbackDataSource(new AmadeusSource(), webSearch, this.log),
      new FallbackDataSource(new BookingSource(), webSearch, this.log),
      new FallbackDataSource(new AmapSource(), webSearch, this.log),
      new FallbackDataSource(new Train12306Source(this.log), webSearch, this.log),
    );

    const flightAgent = new FlightAgent(this.log, dataSource);
    const hotelAgent = new HotelAgent(this.log, dataSource);
    this.llmPlanAgent = new LLMPlanAgent(this.log, dataSource);
    this.activityAgent = new ActivityAgent(this.log, dataSource);
    const budgetAgent = new BudgetAgent(this.log, dataSource);

    this.prefAgent = new PreferenceAgent(this.log);
    this.destAgent = new DestinationAgent(this.log);

    const parallel = new ParallelExecutor([flightAgent, hotelAgent, this.llmPlanAgent], this.log);
    this.budgetLoop = new BudgetLoopController(parallel, budgetAgent, this.log);
  }

  async run(preferences: UserPreferences): Promise<TravelPlanState> {
    const state = new TravelPlanState();
    state.preferences = preferences;

    state.state = PlanningState.COLLECTING_PREFERENCES;
    let result = await this.prefAgent.run(state);
    if (result.state === PlanningState.FAILED) return result;

    result = await this.destAgent.run(result);
    if (result.state === PlanningState.FAILED) return result;

    result = await this.budgetLoop.run(result);

    // Fallback: if LLMPlanAgent degraded, generate activities with mock ActivityAgent
    if (this.isActivityMissing(result) && result.state !== PlanningState.FAILED) {
      this.log.warn("活动规划缺失，降级到 ActivityAgent (mock)。");
      sessionLogger.append("pipeline", "pipeline_fallback", {
        reason: "LLMPlanAgent 失败或超时",
        fallback: "ActivityAgent",
      });
      try {
        result = await this.activityAgent.run(result);
      } catch (fallbackErr) {
        const msg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        this.log.error({ error: msg }, "ActivityAgent fallback 也失败");
        result.errorMessages.push(`活动规划失败: ${msg}`);
      }
    }

    return result;
  }

  private isActivityMissing(state: TravelPlanState): boolean {
    return (
      !state.activityResult ||
      !state.activityResult.dayPlans ||
      state.activityResult.dayPlans.length === 0
    );
  }
}

export async function quickPlan(opts: {
  budget?: number;
  departure?: string;
  start?: string;
  end?: string;
  style?: string;
  travelers?: number;
} = {}): Promise<TravelPlanState> {
  const prefs: UserPreferences = {
    budget: opts.budget ?? 10000,
    travelStyle: (opts.style as TravelStyle) ?? TravelStyle.COMFORT,
    departureCity: opts.departure ?? "北京",
    startDate: opts.start ?? "2026-05-01",
    endDate: opts.end ?? "2026-05-05",
    numTravelers: opts.travelers ?? 1,
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
    diningPreference: "mixed",
  };
  const pipeline = new TravelPlanningPipeline();
  return pipeline.run(prefs);
}
