import type { Logger } from "pino";
import type { Flight, Train, FlightSearchResult, TravelPlanState } from "../types/index.js";
import { createRng, type Rng } from "../utils/prng.js";
import { computeSeed, agentSeed } from "../utils/seed.js";
import { BaseAgent } from "./base-agent.js";

const AIRLINES = ["中国国航", "东方航空", "南方航空", "海南航空", "春秋航空", "吉祥航空"];
const TRAIN_TYPES = [
  { type: "高铁", prefix: "G", priceRatio: 0.55, durRatio: 2.5, seat: "二等座" },
  { type: "动车", prefix: "D", priceRatio: 0.40, durRatio: 3.0, seat: "二等座" },
  { type: "普通", prefix: "K", priceRatio: 0.25, durRatio: 5.0, seat: "硬座" },
];

function generateMockFlights(dep: string, arr: string, date: string, rng: Rng, count = 8): Flight[] {
  const results: Flight[] = [];
  for (let i = 0; i < count; i++) {
    const airline = AIRLINES[i % AIRLINES.length]!;
    const depHour = rng.randInt(6, 20);
    const dur = rng.randFloat(2.0, 12.0);
    const arrHour = Math.min(23, Math.round(depHour + dur));
    results.push({
      airline,
      flightNo: `${airline.slice(0, 2)}${rng.randInt(1000, 9999)}`,
      departureCity: dep,
      arrivalCity: arr,
      departureTime: `${date}T${String(depHour).padStart(2, "0")}:00`,
      arrivalTime: `${date}T${String(arrHour).padStart(2, "0")}:00`,
      price: rng.randInt(800, 5000),
      durationHours: dur,
      stops: rng.pick([0, 0, 0, 1, 1, 2]),
      cabinClass: "economy",
    });
  }
  return results;
}

function generateMockTrains(dep: string, arr: string, date: string, rng: Rng): Train[] {
  return TRAIN_TYPES.map((t) => {
    const basePrice = rng.randInt(200, 1200);
    const price = Math.round(basePrice * t.priceRatio);
    const dur = rng.randFloat(3.0, 14.0) * (t.durRatio / 3.0);
    const depHour = rng.randInt(6, 18);
    const arrHour = Math.min(23, Math.round(depHour + dur));
    return {
      trainNo: `${t.prefix}${rng.randInt(100, 9999)}`,
      trainType: t.type,
      departureCity: dep,
      arrivalCity: arr,
      departureTime: `${date}T${String(depHour).padStart(2, "0")}:00`,
      arrivalTime: `${date}T${String(arrHour).padStart(2, "0")}:00`,
      price,
      durationHours: parseFloat(dur.toFixed(1)),
      seatType: t.seat,
    };
  });
}

export class FlightAgent extends BaseAgent {
  readonly name = "FlightAgent";
  constructor(log: Logger) { super(log); }

  protected async execute(state: TravelPlanState): Promise<TravelPlanState> {
    const pref = state.preferences!;
    const dest = state.selectedDestination!;
    const baseSeed = computeSeed(pref.departureCity, dest.city, pref.startDate, pref.endDate, pref.budget);
    const seed = agentSeed(baseSeed, "flight", state.adjustmentRound);
    const rng = createRng(seed);

    const maxPrice = state.searchConstraints?.maxFlightPricePerPerson;

    let outbound = generateMockFlights(pref.departureCity, dest.city, pref.startDate, rng);
    let returns = generateMockFlights(dest.city, pref.departureCity, pref.endDate, rng);

    if (maxPrice) {
      outbound = outbound.filter((f) => f.price <= maxPrice);
      returns = returns.filter((f) => f.price <= maxPrice);
    }

    const budgetShare = pref.budget * 0.3;
    let recOut = FlightAgent.bestFlight(outbound, budgetShare);
    let recRet = FlightAgent.bestFlight(returns, budgetShare);

    if (!recOut || !recRet) {
      if (state.searchConstraints?.allowTrainFallback !== false) {
        const trainsOut = generateMockTrains(pref.departureCity, dest.city, pref.startDate, rng);
        const trainsRet = generateMockTrains(dest.city, pref.departureCity, pref.endDate, rng);
        const cheapOut = trainsOut.reduce((a, b) => (a.price < b.price ? a : b));
        const cheapRet = trainsRet.reduce((a, b) => (a.price < b.price ? a : b));

        state.transportMode = "train";
        state.trainOutbound = cheapOut;
        state.trainReturn = cheapRet;

        const total = (cheapOut.price + cheapRet.price) * pref.numTravelers;
        state.flightResult = {
          outboundFlights: [],
          returnFlights: [],
          recommendedOutbound: null,
          recommendedReturn: null,
          totalFlightCost: total,
        };
        this.log.info({ agent: this.name, mode: "train", total }, "航班无匹配，启用火车兜底");
        return state;
      }
    }

    const total = ((recOut?.price ?? 0) + (recRet?.price ?? 0)) * pref.numTravelers;
    state.flightResult = {
      outboundFlights: outbound,
      returnFlights: returns,
      recommendedOutbound: recOut,
      recommendedReturn: recRet,
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
