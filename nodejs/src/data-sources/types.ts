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
  maxResults?: number;
}

export interface TrainSearchParams {
  from: string;
  to: string;
  date: string;
}

export interface TravelDataSource {
  searchFlights(params: FlightSearchParams): Promise<Flight[]>;
  searchHotels(params: HotelSearchParams): Promise<Hotel[]>;
  searchAttractions(params: AttractionSearchParams): Promise<Activity[]>;
  searchTrains(params: TrainSearchParams): Promise<Train[]>;
  planTransitRoute?(origin: GeoLocation, destination: GeoLocation, city: string): Promise<TransitRouteResult | null>;
}
