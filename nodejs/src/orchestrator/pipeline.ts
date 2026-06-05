import pino, { type Logger } from "pino";
import { TravelStyle, TravelPlanState, PlanningState, type UserPreferences } from "../types/index.js";
import { PreferenceAgent, DestinationAgent, FlightAgent, HotelAgent, ActivityAgent, BudgetAgent } from "../agents/index.js";
import { AmadeusSource } from "../data-sources/amadeus-source.js";
import { BookingSource } from "../data-sources/booking-source.js";
import { AmapSource } from "../data-sources/amap-source.js";
import { WebSearchSource } from "../data-sources/web-search-source.js";
import { Train12306Source } from "../data-sources/train12306-source.js";
import { FallbackDataSource } from "../data-sources/fallback-data-source.js";
import type { TravelDataSource } from "../data-sources/types.js";
import { ParallelExecutor } from "./parallel.js";
import { BudgetLoopController } from "./budget-loop.js";

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

  constructor(log?: Logger) {
    const logger: Logger = log ?? pino({ level: "info", transport: { target: "pino-pretty", options: { colorize: false, translateTime: "SYS:HH:MM:ss" } } });
    const webSearch = new WebSearchSource(logger);
    const dataSource = new CompositeDataSource(
      new FallbackDataSource(new AmadeusSource(), webSearch, logger),
      new FallbackDataSource(new BookingSource(), webSearch, logger),
      new FallbackDataSource(new AmapSource(), webSearch, logger),
      new FallbackDataSource(new Train12306Source(logger), webSearch, logger),
    );

    const flightAgent = new FlightAgent(logger, dataSource);
    const hotelAgent = new HotelAgent(logger, dataSource);
    const activityAgent = new ActivityAgent(logger, dataSource);
    const budgetAgent = new BudgetAgent(logger, dataSource);

    this.prefAgent = new PreferenceAgent(logger);
    this.destAgent = new DestinationAgent(logger);

    const parallel = new ParallelExecutor([flightAgent, hotelAgent, activityAgent], logger);
    this.budgetLoop = new BudgetLoopController(parallel, budgetAgent, logger);
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
    return result;
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
