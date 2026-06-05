import { ConversationState } from "./state-machine.js";
import { TravelStyle, type UserPreferences, type PlanSummary, type TravelPlanState, type Hotel, type Train, type Flight } from "../types/index.js";

export interface TransportOption {
  id: string;
  mode: "train" | "flight";
  trainNo?: string;
  flightNo?: string;
  airline?: string;
  departStation: string;
  arriveStation: string;
  departTime: string;
  arriveTime: string;
  duration: string;
  price: number;
  note?: string;
  isRecommended: boolean;
}

export interface TransportSearchResult {
  outbound: TransportOption[];
  return: TransportOption[];
}

export interface ConversationContext {
  sessionId: string;
  state: ConversationState;
  version: number;
  createdAt: number;
  updatedAt: number;

  lastError?: {
    state: ConversationState;
    message: string;
    retryCount: number;
    timestamp: number;
  };

  destination?: string;
  departureCity?: string;
  startDate?: string;
  endDate?: string;
  numDays?: number;
  numTravelers?: number;
  budget?: number;
  accommodationStyle?: string;
  travelInterests?: string[];
  foodPreferences?: string[];
  outboundTransportPreference?: string;
  returnTransportPreference?: string;
  specialRequests?: string;
  mustVisitAttractions?: string[];

  transportSearchResult?: TransportSearchResult;
  hotelOptions?: Hotel[];

  selectedOutboundId?: string;
  selectedReturnId?: string;
  selectedHotel?: Hotel;

  planSummary?: PlanSummary;
  editedPlanSummary?: PlanSummary;

  messageHistory: Array<{ role: "user" | "assistant"; content: string }>;
  turnCount: number;
  pendingQuestion?: string;
}

export interface ExtractedFields {
  destination?: string;
  departureCity?: string;
  startDate?: string;
  endDate?: string;
  numTravelers?: number;
  budget?: number;
  accommodationStyle?: string;
  travelInterests?: string[];
  foodPreferences?: string[];
  outboundTransportPreference?: string;
  returnTransportPreference?: string;
  specialRequests?: string;
  mustVisitAttractions?: string[];
}

export const FIELD_GROUPS = {
  basics: ["destination", "departureCity", "startDate", "endDate", "numTravelers"] as const,
  preferences: ["budget", "accommodationStyle", "travelInterests", "outboundTransportPreference", "returnTransportPreference", "mustVisitAttractions"] as const,
  nice: ["foodPreferences"] as const,
} as const;

export function createDefaultContext(sessionId: string): ConversationContext {
  return {
    sessionId,
    state: ConversationState.INIT,
    version: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messageHistory: [],
    turnCount: 0,
  };
}

export function getMissingBasics(ctx: ConversationContext): string[] {
  return FIELD_GROUPS.basics.filter((f) => {
    const val = ctx[f as keyof ConversationContext];
    return val === undefined || val === null || val === "";
  });
}

export function getMissingPreferences(ctx: ConversationContext): string[] {
  return FIELD_GROUPS.preferences.filter((f) => {
    const val = ctx[f as keyof ConversationContext];
    if (Array.isArray(val)) return val.length === 0;
    return val === undefined || val === null || val === "";
  });
}

export function isReadyForPipeline(ctx: ConversationContext): boolean {
  return getMissingBasics(ctx).length === 0;
}

export function mergeExtracted(
  ctx: ConversationContext,
  extracted: ExtractedFields,
): ConversationContext {
  const merged = { ...ctx, updatedAt: Date.now() };

  for (const [key, value] of Object.entries(extracted)) {
    if (value === undefined || value === null) continue;

    if (key === "mustVisitAttractions" && Array.isArray(value)) {
      const existing = (merged as Record<string, unknown>)[key] as string[] | undefined;
      const existingSet = new Set(existing ?? []);
      const merged_arr = [...(existing ?? []), ...value.filter((v) => !existingSet.has(v))];
      (merged as Record<string, unknown>)[key] = merged_arr;
      continue;
    }

    const current = merged[key as keyof ConversationContext];
    if (current !== undefined && current !== null && current !== "") continue;
    (merged as Record<string, unknown>)[key] = value;
  }

  if (merged.startDate && merged.endDate && !merged.numDays) {
    const start = new Date(merged.startDate);
    const end = new Date(merged.endDate);
    if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
      merged.numDays = Math.max(
        1,
        Math.round((end.getTime() - start.getTime()) / 86400000),
      );
    }
  }

  return merged;
}

function transportOptionToTrain(opt: TransportOption): Train {
  return {
    trainNo: opt.trainNo ?? opt.id,
    trainType: opt.mode === "train" ? "高铁" : "动车",
    departureCity: opt.departStation,
    arrivalCity: opt.arriveStation,
    departureTime: opt.departTime,
    arrivalTime: opt.arriveTime,
    price: opt.price,
    durationHours: parseDuration(opt.duration),
    seatType: "二等座",
  };
}

function transportOptionToFlight(opt: TransportOption): Flight {
  return {
    airline: opt.airline ?? "",
    flightNo: opt.flightNo ?? opt.id,
    departureCity: opt.departStation,
    arrivalCity: opt.arriveStation,
    departureTime: opt.departTime,
    arrivalTime: opt.arriveTime,
    price: opt.price,
    durationHours: parseDuration(opt.duration),
    stops: 0,
    cabinClass: "economy",
  };
}

function parseDuration(dur: string): number {
  if (!dur) return 0;
  const hours = dur.match(/(\d+)h/i)?.[1];
  const mins = dur.match(/(\d+)m/i)?.[1];
  return (Number(hours ?? 0)) + (Number(mins ?? 0)) / 60;
}

function findTransportOption(
  opts: TransportOption[] | undefined,
  id: string | undefined,
): TransportOption | undefined {
  if (!id || !opts) return undefined;
  return opts.find((o) => o.id === id);
}

export function toUserPreferences(ctx: ConversationContext): UserPreferences {
  const numDays = ctx.numDays ?? 4;
  const numTravelers = ctx.numTravelers ?? 1;

  const selectedOutboundOpt = findTransportOption(ctx.transportSearchResult?.outbound, ctx.selectedOutboundId);
  const selectedReturnOpt = findTransportOption(ctx.transportSearchResult?.return, ctx.selectedReturnId);
  const selectedHotelOpt = ctx.selectedHotel;

  const selectedOutbound = selectedOutboundOpt
    ? selectedOutboundOpt.mode === "train"
      ? transportOptionToTrain(selectedOutboundOpt)
      : transportOptionToFlight(selectedOutboundOpt)
    : undefined;

  const selectedReturn = selectedReturnOpt
    ? selectedReturnOpt.mode === "train"
      ? transportOptionToTrain(selectedReturnOpt)
      : transportOptionToFlight(selectedReturnOpt)
    : undefined;

  return {
    budget: ctx.budget ?? numTravelers * numDays * 600,
    travelStyle: mapStyle(ctx.accommodationStyle),
    departureCity: ctx.departureCity ?? "北京",
    startDate: ctx.startDate ?? "2026-06-01",
    endDate: ctx.endDate ?? "2026-06-05",
    numTravelers,
    interests: ctx.travelInterests ?? [],
    dietaryRestrictions: [],
    accessibilityNeeds: [],
    notes: ctx.specialRequests ?? "",
    preferredDestination: ctx.destination,
    outboundTransportPreference: (ctx.outboundTransportPreference as UserPreferences["outboundTransportPreference"]) ?? "no_preference",
    returnTransportPreference: (ctx.returnTransportPreference as UserPreferences["returnTransportPreference"]) ?? "no_preference",
    mustVisitAttractions: ctx.mustVisitAttractions ?? [],
    departureTime: "flexible",
    budgetStrictness: "flexible",
    specialRequests: ctx.specialRequests,
    accommodationType: "any",
    preferredHotelBrands: [],
    localTransitMode: "mixed",
    diningPreference: "local_specialties",
    selectedOutbound,
    selectedReturn,
    selectedHotel: selectedHotelOpt,
  };
}

function mapStyle(style?: string): TravelStyle {
  const mapping: Record<string, TravelStyle> = {
    budget: TravelStyle.BUDGET,
    comfort: TravelStyle.COMFORT,
    luxury: TravelStyle.LUXURY,
    adventure: TravelStyle.ADVENTURE,
    cultural: TravelStyle.CULTURAL,
    relaxation: TravelStyle.RELAXATION,
  };
  return mapping[style ?? ""] ?? TravelStyle.COMFORT;
}

export function buildPlanSummary(state: TravelPlanState): PlanSummary {
  const dest = state.selectedDestination;
  const bb = state.budgetBreakdown;
  const days = state.activityResult?.dayPlans.length ?? 0;

  return {
    destination: dest?.city ?? "",
    country: dest?.country ?? "",
    flightCost: bb?.flightCost ?? 0,
    trainCost: bb?.trainCost ?? 0,
    hotelCost: bb?.hotelCost ?? 0,
    activityCost: bb?.activityCost ?? 0,
    totalCost: bb?.totalCost ?? 0,
    budget: bb?.budget ?? 0,
    withinBudget: bb?.isWithinBudget ?? true,
    adjustmentRounds: state.adjustmentRound,
    hotelName: state.hotelResult?.recommended?.name ?? "",
    days,
    highlights: dest?.highlights ?? [],
    warnings: state.errorMessages,
    transportMode: state.transportMode,
    outboundFlights: state.flightResult?.outboundFlights ?? [],
    returnFlights: state.flightResult?.returnFlights ?? [],
    trainOutbound: state.trainOutbound ?? null,
    trainReturn: state.trainReturn ?? null,
    hotels: state.hotelResult?.hotels ?? [],
    dayPlans: state.activityResult?.dayPlans ?? [],
  };
}
