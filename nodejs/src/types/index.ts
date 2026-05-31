import { z } from "zod";

export enum TravelStyle {
  BUDGET = "budget",
  COMFORT = "comfort",
  LUXURY = "luxury",
  ADVENTURE = "adventure",
  CULTURAL = "cultural",
  RELAXATION = "relaxation",
}

export enum ActivitySubType {
  ATTRACTION = "attraction",
  DINING = "dining",
  TRANSIT = "transit",
}

export interface SearchConstraints {
  maxFlightPricePerPerson?: number;
  maxHotelPricePerNight?: number;
  maxHotelStarRating?: number;
  maxActivityCostPerDay?: number;
  preferredCabinClass?: "economy" | "business";
  allowTrainFallback?: boolean;
}

export enum PlanningState {
  COLLECTING_PREFERENCES = "collecting_preferences",
  RECOMMENDING_DESTINATIONS = "recommending_destinations",
  SEARCHING_PARALLEL = "searching_parallel",
  BUDGET_CHECKING = "budget_checking",
  ADJUSTING = "adjusting",
  COMPLETED = "completed",
  FAILED = "failed",
}

export const UserPreferencesSchema = z.object({
  budget: z.number().positive(),
  travelStyle: z.nativeEnum(TravelStyle).default(TravelStyle.COMFORT),
  departureCity: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  numTravelers: z.number().int().min(1).default(1),
  interests: z.array(z.string()).default([]),
  dietaryRestrictions: z.array(z.string()).default([]),
  accessibilityNeeds: z.array(z.string()).default([]),
  notes: z.string().default(""),
  preferredDestination: z.string().optional(),
  transportPreference: z.enum(["flight", "high_speed_rail", "train", "no_preference"]).default("no_preference"),
  departureTime: z.enum(["morning", "afternoon", "evening", "flexible"]).default("flexible"),
  budgetStrictness: z.enum(["strict", "flexible", "luxury"]).default("strict"),
  specialRequests: z.string().optional(),
  accommodationType: z.enum(["hotel", "homestay", "resort", "any"]).default("any"),
  preferredStarRating: z.number().min(1).max(5).optional(),
  preferredHotelBrands: z.array(z.string()).default([]),
  localTransitMode: z.enum(["public_transit", "taxi", "rental_car", "mixed"]).default("mixed"),
  diningPreference: z.enum(["trending", "local_specialties", "mixed"]).default("mixed"),
});
export type UserPreferences = z.infer<typeof UserPreferencesSchema>;

export const DestinationSchema = z.object({
  city: z.string(),
  country: z.string(),
  description: z.string().default(""),
  bestSeason: z.string().default(""),
  visaRequired: z.boolean().default(false),
  safetyScore: z.number().min(0).max(10).default(8.0),
  costLevel: z.string().default("medium"),
  highlights: z.array(z.string()).default([]),
});
export type Destination = z.infer<typeof DestinationSchema>;

export const DestinationRecommendationSchema = z.object({
  destinations: z.array(DestinationSchema),
  selected: DestinationSchema.nullable().default(null),
  reasoning: z.string().default(""),
});
export type DestinationRecommendation = z.infer<typeof DestinationRecommendationSchema>;

export const FlightSchema = z.object({
  airline: z.string(),
  flightNo: z.string(),
  departureCity: z.string(),
  arrivalCity: z.string(),
  departureTime: z.string(),
  arrivalTime: z.string(),
  price: z.number().nonnegative(),
  durationHours: z.number().nonnegative(),
  stops: z.number().int().nonnegative().default(0),
  cabinClass: z.string().default("economy"),
});
export type Flight = z.infer<typeof FlightSchema>;

export const FlightSearchResultSchema = z.object({
  outboundFlights: z.array(FlightSchema).default([]),
  returnFlights: z.array(FlightSchema).default([]),
  recommendedOutbound: FlightSchema.nullable().default(null),
  recommendedReturn: FlightSchema.nullable().default(null),
  totalFlightCost: z.number().default(0),
});
export type FlightSearchResult = z.infer<typeof FlightSearchResultSchema>;

export const HotelSchema = z.object({
  name: z.string(),
  city: z.string(),
  address: z.string().default(""),
  starRating: z.number().min(1).max(5).default(3.0),
  userRating: z.number().min(0).max(10).default(8.0),
  pricePerNight: z.number().nonnegative(),
  amenities: z.array(z.string()).default([]),
  distanceToCenterKm: z.number().nonnegative().default(0),
});
export type Hotel = z.infer<typeof HotelSchema>;

export const HotelSearchResultSchema = z.object({
  hotels: z.array(HotelSchema).default([]),
  recommended: HotelSchema.nullable().default(null),
  totalNights: z.number().int().default(0),
  totalHotelCost: z.number().default(0),
});
export type HotelSearchResult = z.infer<typeof HotelSearchResultSchema>;

export const ActivitySchema = z.object({
  name: z.string(),
  category: z.string().default("sightseeing"),
  location: z.string().default(""),
  durationHours: z.number().nonnegative().default(2.0),
  price: z.number().nonnegative().default(0),
  rating: z.number().min(0).max(10).default(8.0),
  description: z.string().default(""),
  timeSlot: z.string().default(""),
  subType: z.nativeEnum(ActivitySubType).optional(),
  mealType: z.string().optional(),
  geoLocation: z.object({ lon: z.number(), lat: z.number() }).optional(),
});
export type Activity = z.infer<typeof ActivitySchema>;

export const TrainSchema = z.object({
  trainNo: z.string(),
  trainType: z.string().default("高铁"),
  departureCity: z.string(),
  arrivalCity: z.string(),
  departureTime: z.string(),
  arrivalTime: z.string(),
  price: z.number().nonnegative(),
  durationHours: z.number().nonnegative(),
  seatType: z.string().default("二等座"),
});
export type Train = z.infer<typeof TrainSchema>;

export const DayPlanSchema = z.object({
  date: z.string(),
  activities: z.array(ActivitySchema).default([]),
  dayCost: z.number().default(0),
});
export type DayPlan = z.infer<typeof DayPlanSchema>;

export const ActivitySearchResultSchema = z.object({
  dayPlans: z.array(DayPlanSchema).default([]),
  totalActivityCost: z.number().default(0),
});
export type ActivitySearchResult = z.infer<typeof ActivitySearchResultSchema>;

export const BudgetBreakdownSchema = z.object({
  flightCost: z.number().default(0),
  trainCost: z.number().default(0),
  hotelCost: z.number().default(0),
  activityCost: z.number().default(0),
  totalCost: z.number().default(0),
  budget: z.number().default(0),
  remaining: z.number().default(0),
  isWithinBudget: z.boolean().default(true),
  overBudgetAmount: z.number().default(0),
  suggestions: z.array(z.string()).default([]),
});
export type BudgetBreakdown = z.infer<typeof BudgetBreakdownSchema>;

export class TravelPlanState {
  state: PlanningState = PlanningState.COLLECTING_PREFERENCES;
  preferences: UserPreferences | null = null;
  destinationRec: DestinationRecommendation | null = null;
  flightResult: FlightSearchResult | null = null;
  hotelResult: HotelSearchResult | null = null;
  activityResult: ActivitySearchResult | null = null;
  budgetBreakdown: BudgetBreakdown | null = null;
  adjustmentRound = 0;
  maxAdjustments = 3;
  errorMessages: string[] = [];
  searchConstraints: SearchConstraints | null = null;
  transportMode: "flight" | "train" = "flight";
  trainOutbound: Train | null = null;
  trainReturn: Train | null = null;

  get selectedDestination(): Destination | null {
    return this.destinationRec?.selected ?? null;
  }
}

export const PlanRequestSchema = z.object({
  budget: z.number().positive().default(10000),
  departure_city: z.string().default("北京"),
  start_date: z.string().default("2026-05-01"),
  end_date: z.string().default("2026-05-05"),
  travel_style: z.string().default("comfort"),
  num_travelers: z.number().int().min(1).default(1),
  interests: z.array(z.string()).default([]),
  notes: z.string().default(""),
  transport_preference: z.enum(["flight", "high_speed_rail", "train", "no_preference"]).default("no_preference"),
  departure_time: z.enum(["morning", "afternoon", "evening", "flexible"]).default("flexible"),
  budget_strictness: z.enum(["strict", "flexible", "luxury"]).default("strict"),
  special_requests: z.string().optional(),
  accommodation_type: z.enum(["hotel", "homestay", "resort", "any"]).default("any"),
  preferred_star_rating: z.number().min(1).max(5).optional(),
  preferred_hotel_brands: z.array(z.string()).default([]),
  local_transit_mode: z.enum(["public_transit", "taxi", "rental_car", "mixed"]).default("mixed"),
  dining_preference: z.enum(["trending", "local_specialties", "mixed"]).default("mixed"),
});
export type PlanRequest = z.infer<typeof PlanRequestSchema>;

export interface PlanSummary {
  destination: string;
  country: string;
  flightCost: number;
  trainCost: number;
  hotelCost: number;
  activityCost: number;
  totalCost: number;
  budget: number;
  withinBudget: boolean;
  adjustmentRounds: number;
  hotelName: string;
  days: number;
  highlights: string[];
  warnings: string[];
  transportMode: "flight" | "train";
  outboundFlights: Flight[];
  returnFlights: Flight[];
  trainOutbound: Train | null;
  trainReturn: Train | null;
  hotels: Hotel[];
  dayPlans: DayPlan[];
}

export interface GeoLocation {
  lon: number;
  lat: number;
}

export interface TransitSegment {
  type: "walking" | "bus" | "subway";
  lineName?: string;
  fromStop?: string;
  toStop?: string;
  distanceMeters: number;
  durationMinutes: number;
}

export interface TransitRouteResult {
  mode: "subway" | "bus" | "taxi" | "walk";
  description: string;
  cost: number;
  durationMinutes: number;
  walkingDistanceMeters: number;
  transfers: number;
  segments: TransitSegment[];
}
