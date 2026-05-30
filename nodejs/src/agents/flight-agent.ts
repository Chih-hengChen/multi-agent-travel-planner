import type { Logger } from "pino";
import type { Flight, FlightSearchResult, TravelPlanState } from "../types/index.js";
import { BaseAgent } from "./base-agent.js";

const AIRLINES = ["中国国航", "东方航空", "南方航空", "海南航空", "春秋航空", "吉祥航空"];

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFloat(min: number, max: number, decimals = 1): number {
  return parseFloat((Math.random() * (max - min) + min).toFixed(decimals));
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateMockFlights(dep: string, arr: string, date: string, count = 5): Flight[] {
  const results: Flight[] = [];
  for (let i = 0; i < count; i++) {
    const airline = AIRLINES[i % AIRLINES.length]!;
    results.push({
      airline,
      flightNo: `${airline.slice(0, 2)}${randInt(1000, 9999)}`,
      departureCity: dep,
      arrivalCity: arr,
      departureTime: `${date}T${String(randInt(6, 20)).padStart(2, "0")}:00`,
      arrivalTime: `${date}T${String(randInt(8, 23)).padStart(2, "0")}:00`,
      price: randInt(800, 5000),
      durationHours: randFloat(2.0, 12.0),
      stops: pick([0, 0, 0, 1, 1, 2]),
      cabinClass: "economy",
    });
  }
  return results;
}

export class FlightAgent extends BaseAgent {
  readonly name = "FlightAgent";
  constructor(log: Logger) { super(log); }

  protected async execute(state: TravelPlanState): Promise<TravelPlanState> {
    const pref = state.preferences;
    const dest = state.selectedDestination;
    if (!pref || !dest) throw new Error("缺少偏好或目的地信息");

    const outbound = generateMockFlights(pref.departureCity, dest.city, pref.startDate);
    const returns = generateMockFlights(dest.city, pref.departureCity, pref.endDate);

    const recOut = FlightAgent.bestFlight(outbound, pref.budget * 0.3);
    const recRet = FlightAgent.bestFlight(returns, pref.budget * 0.3);
    const total = ((recOut?.price ?? 0) + (recRet?.price ?? 0)) * pref.numTravelers;

    state.flightResult = {
      outboundFlights: outbound,
      returnFlights: returns,
      recommendedOutbound: recOut,
      recommendedReturn: recRet,
      totalFlightCost: total,
    };
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
