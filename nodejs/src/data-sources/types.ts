import type { Flight, Hotel, Activity, Train, GeoLocation, TransitRouteResult } from "../types/index.js";

export interface FlightSearchParams {
  origin: string;
  destination: string;
  departureDate: string;
  adults: number;
  maxPrice?: number;
}

export interface HotelSearchParams {
  city: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  maxPricePerNight?: number;
  maxStarRating?: number;
}

export interface AttractionSearchParams {
  city: string;
  interests?: string[];
  query?: string;
  maxResults?: number;
}

export interface TrainSearchParams {
  from: string;
  to: string;
  date: string;
  maxPrice?: number;
}

export interface RestaurantSearchParams {
  city: string;
  mealType: "breakfast" | "lunch" | "dinner";
  diningPreference?: "trending" | "local_specialties" | "mixed";
  maxResults?: number;
}

export interface TravelDataSource {
  searchFlights(params: FlightSearchParams): Promise<Flight[]>;
  searchHotels(params: HotelSearchParams): Promise<Hotel[]>;
  searchAttractions(params: AttractionSearchParams): Promise<Activity[]>;
  searchTrains(params: TrainSearchParams): Promise<Train[]>;
  searchRestaurants(params: RestaurantSearchParams): Promise<Activity[]>;
  planTransitRoute?(origin: GeoLocation, destination: GeoLocation, city: string): Promise<TransitRouteResult | null>;
}
