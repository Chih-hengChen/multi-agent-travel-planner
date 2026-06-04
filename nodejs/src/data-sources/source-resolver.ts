import type { TravelDataSource, FlightSearchParams, HotelSearchParams, TrainSearchParams } from "./types.js";
import type { Flight, Hotel, Train } from "../types/index.js";
import pino, { type Logger } from "pino";
import { settings } from "../config/settings.js";

export type DataType = "train" | "flight" | "hotel";

const METHOD_MAP: Record<DataType, keyof TravelDataSource> = {
  train: "searchTrains",
  flight: "searchFlights",
  hotel: "searchHotels",
};

export class SourceResolver {
  private readonly sources: TravelDataSource[];
  private readonly timeout: number;
  private readonly log: Logger;

  constructor(sources: TravelDataSource[], log?: Logger) {
    this.sources = sources;
    this.timeout = settings.SEARCH_TIMEOUT_MS;
    this.log = log ?? pino({ level: settings.LOG_LEVEL });
  }

  async resolveTrains(params: TrainSearchParams): Promise<Train[]> {
    return this.resolve("train", params) as Promise<Train[]>;
  }

  async resolveFlights(params: FlightSearchParams): Promise<Flight[]> {
    return this.resolve("flight", params) as Promise<Flight[]>;
  }

  async resolveHotels(params: HotelSearchParams): Promise<Hotel[]> {
    return this.resolve("hotel", params) as Promise<Hotel[]>;
  }

  private async resolve(type: DataType, params: unknown): Promise<unknown[]> {
    const method = METHOD_MAP[type];

    for (let i = 0; i < this.sources.length; i++) {
      const source = this.sources[i];
      const fn = source[method];
      if (typeof fn !== "function") continue;

      try {
        const result = await Promise.race([
          (fn as Function).call(source, params),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Source ${i} timed out`)), this.timeout),
          ),
        ]);

        if (Array.isArray(result) && result.length > 0) {
          this.log.info({ type, sourceIndex: i, count: result.length }, "Source resolved");
          return result;
        }
      } catch (err) {
        this.log.warn({ type, sourceIndex: i, err: String(err) }, "Source failed, trying next");
      }
    }

    this.log.warn({ type }, "All sources failed");
    return [];
  }
}
