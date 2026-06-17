import type { UserPreferences, Hotel, Activity } from "../types/index.js";
import type { TransportOption } from "../conversation/context.js";

export type Phase = "gathering" | "searching" | "selecting" | "planning" | "completed";

export const MAX_BUDGET_ROUNDS = 3;
const CONTINUE_SIGNALS = ["还需要", "继续", "待补", "TODO", "下一步"];

export interface WeatherSummary {
  date: string;
  weather: string;
  highC: number;
  lowC: number;
  rainProbability: number;
}

export interface XhsNote {
  noteId: string;
  title: string;
  content: string;
  likedCount: number;
  author: string;
  url?: string;
  tags: string[];
  publishedAt?: string;
}

export interface TransitSegment {
  from: string;
  to: string;
  mode: "transit" | "walking" | "driving" | "rideshare";
  durationMin: number;
  distanceKm: number;
  cost: string;
  costAmount: number;
  steps: string[];
  fallbackLevel: 0 | 1 | 2;
}

export interface ItinerarySlot {
  attractions: Activity[];
  transitToNext?: TransitSegment;
  notes?: string;
}

export interface DiningPlan {
  meal: "breakfast" | "lunch" | "dinner";
  restaurant?: Activity;
  alternatives?: string[];
  isLocalSpecialty: boolean;
}

export interface PlanDayPlan {
  dayIdx: number;
  date: string;
  theme?: string;
  morning?: ItinerarySlot;
  afternoon?: ItinerarySlot;
  evening?: ItinerarySlot;
  dining: DiningPlan[];
  transitTips: string[];
}

export interface BudgetBreakdownV2 {
  totalCost: number;
  byCategory: {
    transport: number;
    accommodation: number;
    food: number;
    attractions: number;
    other: number;
  };
  budgetLimit: number;
  isWithinBudget: boolean;
  variance: number;
  suggestions?: string[];
}

export interface AgentState {
  phase: Phase;
  iteration: number;
  budgetRound: number;

  preferences?: UserPreferences;

  baikeKnowledge?: string;
  weather?: WeatherSummary;
  candidateAttractions?: Activity[];
  candidateHotels?: Hotel[];
  candidateRestaurants?: Activity[];
  candidateTransports?: TransportOption[];
  xhsNotes?: XhsNote[];

  selectedOutbound?: TransportOption;
  selectedReturn?: TransportOption;
  selectedHotel?: Hotel;

  dayPlans?: PlanDayPlan[];
  budgetBreakdown?: BudgetBreakdownV2;
  planningRestaurants?: Record<string, Activity[]>;

  priceWarnings: string[];
  errorMessages: string[];
  toolErrors: Record<string, string>;
  rerankScores: Record<string, number>;
  lastThought?: string;
  fallbackUsage: Record<string, number>;

  _pendingBudgetFeedback?: string;
}

export function createInitialAgentState(): AgentState {
  return {
    phase: "gathering",
    iteration: 0,
    budgetRound: 0,
    priceWarnings: [],
    errorMessages: [],
    toolErrors: {},
    rerankScores: {},
    fallbackUsage: {},
  };
}

export function computeTravelDays(prefs: UserPreferences): number {
  const start = new Date(prefs.startDate).getTime();
  const end = new Date(prefs.endDate).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return 1;
  return Math.max(1, Math.floor((end - start) / 86_400_000));
}

export function isPreferencesComplete(prefs: UserPreferences | undefined): boolean {
  if (!prefs) return false;
  return Boolean(
    prefs.preferredDestination &&
    prefs.departureCity &&
    prefs.startDate &&
    prefs.endDate &&
    prefs.numTravelers &&
    prefs.budget,
  );
}

export function maybeAdvancePhase(state: AgentState): AgentState {
  switch (state.phase) {
    case "gathering":
      if (isPreferencesComplete(state.preferences)) {
        return { ...state, phase: "searching" };
      }
      return state;

    case "searching":
      if ((state.candidateTransports?.length ?? 0) > 0 && (state.candidateHotels?.length ?? 0) > 0) {
        return { ...state, phase: "selecting" };
      }
      return state;

    case "selecting":
      if (state.selectedOutbound && state.selectedReturn && state.selectedHotel) {
        return { ...state, phase: "planning" };
      }
      return state;

    case "planning": {
      const travelDays = state.preferences ? computeTravelDays(state.preferences) : 0;
      const daysPlanned = state.dayPlans?.length ?? 0;
      const withinBudget = state.budgetBreakdown?.isWithinBudget === true;
      if (daysPlanned === travelDays && travelDays > 0 && state.budgetBreakdown) {
        if (withinBudget) {
          if (state.lastThought && CONTINUE_SIGNALS.some(s => state.lastThought!.includes(s))) {
            return state;
          }
          return { ...state, phase: "completed" };
        }
        if (state.budgetRound >= MAX_BUDGET_ROUNDS) {
          return { ...state, phase: "completed" };
        }
      }
      return state;
    }

    case "completed":
      return state;
  }
}

export function canFinish(state: AgentState): boolean {
  if (state.phase !== "completed") return false;

  const travelDays = state.preferences ? computeTravelDays(state.preferences) : 0;
  if ((state.dayPlans?.length ?? 0) !== travelDays) return false;
  if (!state.budgetBreakdown) return false;

  return true;
}

export function getMissingRequirements(state: AgentState): string[] {
  const missing: string[] = [];
  switch (state.phase) {
    case "gathering": {
      const p = state.preferences;
      if (!p) return ["preferences (全部)"];
      if (!p.preferredDestination) missing.push("destination");
      if (!p.departureCity) missing.push("departureCity");
      if (!p.startDate) missing.push("startDate");
      if (!p.endDate) missing.push("endDate");
      if (!p.numTravelers) missing.push("numTravelers");
      if (!p.budget) missing.push("budget");
      break;
    }
    case "searching": {
      if (!(state.candidateTransports?.length)) missing.push("candidateTransports (search_flights/trains)");
      if (!(state.candidateHotels?.length)) missing.push("candidateHotels (search_hotels)");
      if (!state.baikeKnowledge) missing.push("baikeKnowledge (search_baike)");
      break;
    }
    case "selecting": {
      if (!state.selectedOutbound) missing.push("selectedOutbound");
      if (!state.selectedReturn) missing.push("selectedReturn");
      if (!state.selectedHotel) missing.push("selectedHotel");
      break;
    }
    case "planning": {
      const travelDays = state.preferences ? computeTravelDays(state.preferences) : 0;
      if ((state.dayPlans?.length ?? 0) < travelDays) {
        missing.push(`dayPlans (need ${travelDays}, have ${state.dayPlans?.length ?? 0})`);
      }
      if (!state.budgetBreakdown) missing.push("budgetBreakdown");
      break;
    }
    case "completed":
      break;
  }
  return missing;
}
