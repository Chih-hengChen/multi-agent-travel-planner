import type { Logger } from "pino";
import type { TravelDataSource } from "./types.js";
import type { Flight, Hotel, Activity, Train } from "../types/index.js";
import type { GeoLocation, TransitRouteResult } from "../types/index.js";

export class FallbackDataSource implements TravelDataSource {
  constructor(
    private readonly primary: TravelDataSource,
    private readonly fallback: TravelDataSource,
    private readonly logger: Logger,
  ) {}

  async searchFlights(...args: Parameters<TravelDataSource["searchFlights"]>): Promise<Flight[]> {
    return this.withFallback("searchFlights", args, this.primary.searchFlights(...args));
  }

  async searchHotels(...args: Parameters<TravelDataSource["searchHotels"]>): Promise<Hotel[]> {
    return this.withFallback("searchHotels", args, this.primary.searchHotels(...args));
  }

  async searchAttractions(...args: Parameters<TravelDataSource["searchAttractions"]>): Promise<Activity[]> {
    return this.withFallback("searchAttractions", args, this.primary.searchAttractions(...args));
  }

  async searchTrains(...args: Parameters<TravelDataSource["searchTrains"]>): Promise<Train[]> {
    return this.withFallback("searchTrains", args, this.primary.searchTrains(...args));
  }

  async searchRestaurants(...args: Parameters<TravelDataSource["searchRestaurants"]>): Promise<Activity[]> {
    return this.withFallback("searchRestaurants", args, this.primary.searchRestaurants(...args));
  }

  async planTransitRoute(origin: GeoLocation, destination: GeoLocation, city: string): Promise<TransitRouteResult | null> {
    try {
      if (this.primary.planTransitRoute) {
        const result = await this.primary.planTransitRoute(origin, destination, city);
        if (result) return result;
      }
    } catch { /* fallback */ }
    if (this.fallback.planTransitRoute) {
      return this.fallback.planTransitRoute(origin, destination, city);
    }
    return null;
  }

  private async withFallback<T>(method: string, _args: unknown[], primaryPromise: Promise<T[]>): Promise<T[]> {
    try {
      const results = await primaryPromise;
      if (results.length > 0) return results;
      this.logger.info({ method }, "主数据源返回空，降级到 web search");
    } catch (err) {
      this.logger.warn({ method, err: err instanceof Error ? err.message : String(err) }, "主数据源失败，降级到 web search");
    }

    try {
      const fb = this.fallback as unknown as Record<string, Function>;
      if (typeof fb[method] === "function") {
        return await fb[method].apply(this.fallback, _args);
      }
    } catch (err) {
      this.logger.warn({ method, err: err instanceof Error ? err.message : String(err) }, "降级数据源也失败");
    }
    return [];
  }
}
