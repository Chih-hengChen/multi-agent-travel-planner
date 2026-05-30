import type { Logger } from "pino";
import type { Flight, Train, FlightSearchResult, TravelPlanState } from "../types/index.js";
import type { TravelDataSource } from "../data-sources/types.js";
import { estimateTrainPrice } from "../data-sources/train-data.js";
import { BaseAgent } from "./base-agent.js";

export class FlightAgent extends BaseAgent {
  readonly name = "FlightAgent";
  constructor(log: Logger, dataSource: TravelDataSource) { super(log, dataSource); }

  protected async execute(state: TravelPlanState): Promise<TravelPlanState> {
    const pref = state.preferences!;
    const dest = state.selectedDestination!;
    const maxPrice = state.searchConstraints?.maxFlightPricePerPerson;

    if (pref.transportPreference === "high_speed_rail" || pref.transportPreference === "train") {
      return this.useTrainFallback(state, pref, dest);
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
    let recOut = FlightAgent.bestFlight(outbound, budgetShare);
    let recRet = FlightAgent.bestFlight(returns, budgetShare);

    if (!recOut || !recRet) {
      if (state.searchConstraints?.allowTrainFallback !== false) {
        const trainsOut = estimateTrainPrice(pref.departureCity, dest.city);
        const trainsRet = estimateTrainPrice(dest.city, pref.departureCity);

        if (trainsOut.length > 0 && trainsRet.length > 0) {
          const cheapOut = trainsOut.reduce((a, b) => (a.price < b.price ? a : b));
          const cheapRet = trainsRet.reduce((a, b) => (a.price < b.price ? a : b));

          state.transportMode = "train";
          state.trainOutbound = cheapOut;
          state.trainReturn = cheapRet;

          const total = (cheapOut.price + cheapRet.price) * pref.numTravelers;
          state.flightResult = {
            outboundFlights: [], returnFlights: [],
            recommendedOutbound: null, recommendedReturn: null,
            totalFlightCost: total,
          };
          this.log.info({ agent: this.name, mode: "train", total }, "航班无匹配，启用火车兜底");
          return state;
        }
      }
    }

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

  private async useTrainFallback(state: TravelPlanState, pref: NonNullable<TravelPlanState["preferences"]>, dest: NonNullable<TravelPlanState["selectedDestination"]>): Promise<TravelPlanState> {
    const trainsOut = estimateTrainPrice(pref.departureCity, dest.city);
    const trainsRet = estimateTrainPrice(dest.city, pref.departureCity);
    const cheapOut = trainsOut.length > 0 ? trainsOut.reduce((a, b) => (a.price < b.price ? a : b)) : null;
    const cheapRet = trainsRet.length > 0 ? trainsRet.reduce((a, b) => (a.price < b.price ? a : b)) : null;

    state.transportMode = "train";
    state.trainOutbound = cheapOut;
    state.trainReturn = cheapRet;
    const total = ((cheapOut?.price ?? 0) + (cheapRet?.price ?? 0)) * pref.numTravelers;
    state.flightResult = {
      outboundFlights: [], returnFlights: [],
      recommendedOutbound: null, recommendedReturn: null,
      totalFlightCost: total,
    };
    this.log.info({ agent: this.name, mode: "train_pref", total }, "用户偏好火车，直接使用火车");
    return state;
  }
}
