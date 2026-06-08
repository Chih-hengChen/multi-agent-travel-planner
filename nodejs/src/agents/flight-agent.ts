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

    if (pref.selectedOutbound && pref.selectedReturn) {
      const outIsTrain = "trainNo" in pref.selectedOutbound;
      if (outIsTrain) {
        state.trainOutbound = pref.selectedOutbound as Train;
        state.trainReturn = pref.selectedReturn as Train;
        state.transportMode = "train";
        state.flightResult = {
          outboundFlights: [], returnFlights: [],
          recommendedOutbound: null, recommendedReturn: null,
          totalFlightCost: 0,
        };
        const total = (state.trainOutbound.price + state.trainReturn.price) * pref.numTravelers;
        this.log.info({ agent: this.name, out: state.trainOutbound.trainNo, ret: state.trainReturn.trainNo, total }, "使用用户选择的高铁");
      } else {
        const outFlight = pref.selectedOutbound as Flight;
        const retFlight = pref.selectedReturn as Flight;
        state.transportMode = "flight";
        state.flightResult = {
          outboundFlights: [outFlight], returnFlights: [retFlight],
          recommendedOutbound: outFlight, recommendedReturn: retFlight,
          totalFlightCost: (outFlight.price + retFlight.price) * pref.numTravelers,
        };
        this.log.info({ agent: this.name, out: outFlight.flightNo, ret: retFlight.flightNo }, "使用用户选择的航班");
      }
      return state;
    }

    if (pref.departureCity === dest.city) {
      state.transportMode = "flight";
      state.flightResult = {
        outboundFlights: [], returnFlights: [],
        recommendedOutbound: null, recommendedReturn: null,
        totalFlightCost: 0,
      };
      this.log.info({ agent: this.name, reason: "same_city" }, "同城旅行，无需交通");
      return state;
    }

    const tp = pref.outboundTransportPreference;
    const wantTrain = tp === "high_speed_rail" || tp === "train";

    if (wantTrain) {
      return this.searchTrains(state);
    }

    if (tp === "no_preference") {
      const trainState = await this.searchTrains(state);
      if (trainState.trainOutbound && trainState.trainReturn) {
        this.log.info({ agent: this.name }, "无偏好时优先选择高铁");
        return trainState;
      }
      this.log.info({ agent: this.name }, "高铁无结果，回退航班");
    }

    return this.searchFlights(state);
  }

  private async searchTrains(state: TravelPlanState): Promise<TravelPlanState> {
    const pref = state.preferences!;
    const dest = state.selectedDestination!;
    const maxPrice = state.searchConstraints?.maxFlightPricePerPerson;

    const outbound = await this.dataSource.searchTrains({
      from: pref.departureCity,
      to: dest.city,
      date: pref.startDate,
      maxPrice,
    });
    const returns = await this.dataSource.searchTrains({
      from: dest.city,
      to: pref.departureCity,
      date: pref.endDate,
      maxPrice,
    });

    const budgetShare = pref.budget * 0.3;
    state.trainOutbound = FlightAgent.bestTrain(outbound, budgetShare);
    state.trainReturn = FlightAgent.bestTrain(returns, budgetShare);

    if (state.trainOutbound && state.trainReturn) {
      state.transportMode = "train";
      state.flightResult = {
        outboundFlights: [], returnFlights: [],
        recommendedOutbound: null, recommendedReturn: null,
        totalFlightCost: 0,
      };
      const total = (state.trainOutbound.price + state.trainReturn.price) * pref.numTravelers;
      this.log.info({ agent: this.name, out: state.trainOutbound.trainNo, ret: state.trainReturn.trainNo, total }, "高铁搜索完成");
    } else {
      this.log.info({ agent: this.name, outCount: outbound.length, retCount: returns.length }, "高铁搜索结果不足");
    }

    return state;
  }

  private async searchFlights(state: TravelPlanState): Promise<TravelPlanState> {
    const pref = state.preferences!;
    const dest = state.selectedDestination!;
    const maxPrice = state.searchConstraints?.maxFlightPricePerPerson;

    const outbound = await this.dataSource.searchFlights({
      origin: pref.departureCity,
      destination: dest.city,
      departureDate: pref.startDate,
      adults: pref.numTravelers,
      maxPrice,
    });
    const returns = await this.dataSource.searchFlights({
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

  static bestTrain(trains: Train[], budgetShare: number): Train | null {
    if (trains.length === 0) return null;
    const maxPrice = Math.max(...trains.map((t) => t.price)) || 1;
    const maxDur = Math.max(...trains.map((t) => t.durationHours)) || 1;

    const score = (t: Train): number => {
      const priceScore = 1 - t.price / maxPrice;
      const durScore = 1 - t.durationHours / maxDur;
      const budgetBonus = t.price <= budgetShare ? 10 : 0;
      const gBonus = t.trainType.includes("高铁") || t.trainNo.startsWith("G") ? 5 : 0;
      return priceScore * 40 + durScore * 35 + budgetBonus + gBonus;
    };

    return trains.reduce((best, t) => (score(t) > score(best) ? t : best));
  }
}
