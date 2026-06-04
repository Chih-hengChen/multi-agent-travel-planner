import { ConversationState } from "./state-machine.js";
import { TravelStyle, type UserPreferences, type PlanSummary, type TravelPlanState } from "../types/index.js";

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
  transportPreference?: string;
  specialRequests?: string;

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
  transportPreference?: string;
  specialRequests?: string;
}

export const FIELD_GROUPS = {
  basics: ["destination", "departureCity", "startDate", "endDate", "numTravelers"] as const,
  preferences: ["budget", "accommodationStyle", "travelInterests"] as const,
  nice: ["foodPreferences", "transportPreference"] as const,
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

export function toUserPreferences(ctx: ConversationContext): UserPreferences {
  const numDays = ctx.numDays ?? 4;
  const numTravelers = ctx.numTravelers ?? 1;

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
    transportPreference: (ctx.transportPreference as UserPreferences["transportPreference"]) ?? "no_preference",
    departureTime: "flexible",
    budgetStrictness: "flexible",
    specialRequests: ctx.specialRequests,
    accommodationType: "any",
    preferredHotelBrands: [],
    localTransitMode: "mixed",
    diningPreference: "mixed",
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
