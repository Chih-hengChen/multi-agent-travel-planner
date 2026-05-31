import type { Logger } from "pino";
import type { Flight, Train, FlightSearchResult, TravelPlanState } from "../types/index.js";
import type { TravelDataSource } from "../data-sources/types.js";
import { BaseAgent } from "./base-agent.js";

export class FlightAgent extends BaseAgent {
  readonly name = "FlightAgent";
  constructor(log: Logger, dataSource: TravelDataSource) { super(log, dataSource); }

  protected async execute(state: TravelPlanState): Promise<TravelPlanState> {
    const pref = state.preferences!;
    const dest = state.selectedDestination!;
    const maxPrice = state.searchConstraints?.maxFlightPricePerPerson;

    if (pref.departureCity === dest.city) {
      state.transportMode = "flight";
      state.flightResult = {
        outboundFlights: [], returnFlights: [],
        recommendedOutbound: null, recommendedReturn: null,
        totalFlightCost: 0,
      };
      this.log.info({ agent: this.name, reason: "same_city" }, "同城旅行，无需航班");
      return state;
    }

    let outbound = await this.dataSource.searchFlights({
      origin: pref.departureCity,
      destination: dest.city,
      departureDate: pref.startDate,
      adults: pref.numTravelers,
      maxPrice,
    });
    let returns = await this.dataSource.searchFlights({
      origin: dest.city,
      destination: pref.departureCity,
      departureDate: pref.endDate,
      adults: pref.numTravelers,
      maxPrice,
    });

    const budgetShare = pref.budget * 0.3;
    const recOut = FlightAgent.bestFlight(outbound, budgetShare);
    const recRet = FlightAgent.bestFlight(returns, budgetShare);

    const total = ((recOut?.price ?? 0) + (recRet?.price ?? 0)) * pref.numTravelers;
    state.flightResult = {
      outboundFlights: outbound, returnFlights: returns,
      recommendedOutbound: recOut, recommendedReturn: recRet,
      totalFlightCost: total,
    };
    state.transportMode = "flight";
    this.log.info({ agent: this.name, outbound: outbound.length, returns: returns.length, total }, "航班搜索完成");
    return state;
  }

  static bestFlight(flights: Flight[], budgetShare: number): Flight | null {
    if (flights.length === 0) return null;
    const maxPrice = Math.max(...flights.map((f) => f.price)) || 1;
    const maxDur = Math.max(...flights.map((f) => f.durationHours)) || 1;

    const score = (f: Flight): number => {
      const priceScore = 1 - f.price / maxPrice;
      const durScore = 1 - f.durationHours / maxDur;
      const stopScore = 1 - f.stops / 3;
      const budgetBonus = f.price <= budgetShare ? 10 : 0;
      return priceScore * 50 + durScore * 30 + stopScore * 20 + budgetBonus;
    };

    return flights.reduce((best, f) => (score(f) > score(best) ? f : best));
  }
}
