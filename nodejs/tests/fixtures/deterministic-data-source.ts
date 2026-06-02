import type { Flight, Hotel, Activity, Train, GeoLocation, TransitRouteResult } from "../../src/types/index.js";
import type { TravelDataSource } from "../../src/data-sources/types.js";

export interface CallLog {
  searchFlights: number;
  searchHotels: number;
  searchAttractions: number;
  searchTrains: number;
  searchRestaurants: number;
  planTransitRoute: number;
}

function createCallLog(): CallLog {
  return { searchFlights: 0, searchHotels: 0, searchAttractions: 0, searchTrains: 0, searchRestaurants: 0, planTransitRoute: 0 };
}

export interface TestDataSource extends TravelDataSource {
  calls: CallLog;
}

export function createTestDataSource(config: {
  flights?: Flight[];
  returnFlights?: Flight[];
  trains?: Train[];
  returnTrains?: Train[];
  hotels?: Hotel[];
  attractions?: Activity[];
  restaurants?: Activity[];
  transitRoutes?: Map<string, TransitRouteResult>;
}): TestDataSource {
  const calls = createCallLog();

  return {
    calls,
    async searchFlights(params) {
      calls.searchFlights++;
      if (params.origin === config.flights?.[0]?.departureCity) return config.flights ?? [];
      return config.returnFlights ?? config.flights ?? [];
    },
    async searchHotels() {
      calls.searchHotels++;
      return config.hotels ?? [];
    },
    async searchAttractions() {
      calls.searchAttractions++;
      return config.attractions ?? [];
    },
    async searchTrains(params) {
      calls.searchTrains++;
      const outbound = config.trains ?? [];
      if (params.from === outbound[0]?.departureCity) return outbound;
      return config.returnTrains ?? outbound;
    },
    async searchRestaurants() {
      calls.searchRestaurants++;
      return config.restaurants ?? [];
    },
    async planTransitRoute(origin: GeoLocation, destination: GeoLocation, city: string) {
      calls.planTransitRoute++;
      if (!config.transitRoutes) return null;
      const key = `${origin.lat},${origin.lon}-${destination.lat},${destination.lon}`;
      return config.transitRoutes.get(key) ?? null;
    },
  };
}

export function createFailingDataSource(errors: Partial<Record<keyof TravelDataSource, Error>>): TravelDataSource {
  return {
    async searchFlights() {
      if (errors.searchFlights) throw errors.searchFlights;
      return [];
    },
    async searchHotels() {
      if (errors.searchHotels) throw errors.searchHotels;
      return [];
    },
    async searchAttractions() {
      if (errors.searchAttractions) throw errors.searchAttractions;
      return [];
    },
    async searchTrains() {
      if (errors.searchTrains) throw errors.searchTrains;
      return [];
    },
    async searchRestaurants() {
      if (errors.searchRestaurants) throw errors.searchRestaurants;
      return [];
    },
  };
}
