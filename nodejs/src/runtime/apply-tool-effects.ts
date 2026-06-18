import type { Activity, Hotel, UserPreferences } from "../types/index.js";
import type {
  AgentState,
  PlanDayPlan,
  BudgetBreakdownV2,
  TransitSegment,
  XhsNote,
} from "./state.js";
import { MAX_BUDGET_ROUNDS } from "./state.js";

export interface ToolResultLike {
  toolName: string;
  success: boolean;
  data?: unknown;
  error?: string;
  fallbackLevel?: number;
}

type AgentStateField = keyof AgentState;

export type StateReducer = (state: AgentState, data: any) => AgentState;

function pickScores(scores: Record<string, number>, items: { name: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    if (scores[item.name] !== undefined) out[item.name] = scores[item.name];
  }
  return out;
}

function appendCandidates<K extends AgentStateField>(
  state: AgentState,
  field: K,
  items: Activity[],
  scores: Record<string, number>,
): AgentState {
  const existing = (state[field] as Activity[] | undefined) ?? [];
  const seen = new Set(existing.map(x => x.name));
  const fresh = items.filter(x => !seen.has(x.name));
  return {
    ...state,
    [field]: [...existing, ...fresh],
    rerankScores: { ...state.rerankScores, ...pickScores(scores, fresh) },
  };
}

function appendPlanningRestaurants(
  state: AgentState,
  near: string,
  items: Activity[],
  scores: Record<string, number>,
): AgentState {
  const existing = state.planningRestaurants ?? {};
  const prior = existing[near] ?? [];
  const seen = new Set(prior.map(x => x.name));
  const fresh = items.filter(x => !seen.has(x.name));

  return {
    ...state,
    planningRestaurants: {
      ...existing,
      [near]: [...prior, ...fresh],
    },
    rerankScores: { ...state.rerankScores, ...pickScores(scores, fresh) },
  };
}

function mergeXhsNotes(state: AgentState, notes: XhsNote[]): AgentState {
  const existing = state.xhsNotes ?? [];
  const seen = new Set(existing.map(n => n.noteId));
  const fresh = notes.filter(n => !seen.has(n.noteId));
  return { ...state, xhsNotes: [...existing, ...fresh] };
}

function appendTransit(state: AgentState, dayIdx: number, transit: TransitSegment): AgentState {
  const plans = state.dayPlans ?? [];
  if (dayIdx < 0 || dayIdx >= plans.length) {
    return { ...state, errorMessages: [...state.errorMessages, `plan_transit dayIdx ${dayIdx} 越界 (dayPlans.length=${plans.length})`] };
  }
  const nextPlans = plans.map((plan, idx) => {
    if (idx !== dayIdx) return plan;
    const tips = [...plan.transitTips, `${transit.from} → ${transit.to}: ${transit.mode} ${transit.durationMin}min ${transit.cost}`];
    return { ...plan, transitTips: tips };
  });
  return { ...state, dayPlans: nextPlans };
}

function mergePrefs(prev: UserPreferences | undefined, patch: Partial<UserPreferences>): UserPreferences {
  return { ...(prev ?? {} as UserPreferences), ...patch } as UserPreferences;
}

function budgetExceedPrompt(breakdown: BudgetBreakdownV2, prefs: UserPreferences): string {
  const overage = breakdown.totalCost - breakdown.budgetLimit;
  const suggestions = breakdown.suggestions?.length
    ? "\n建议:" + breakdown.suggestions.map((s: string) => `- ${s}`).join("\n")
    : "";
  return `行程预算超出。
预算:¥${prefs.budget}(共 ${prefs.numTravelers ?? 1} 人 × ${prefs.budgetStrictness ?? "strict"} 模式)
实际:¥${breakdown.totalCost}(超 ¥${overage})
分类:交通 ¥${breakdown.byCategory.transport} / 住宿 ¥${breakdown.byCategory.accommodation} / 餐饮 ¥${breakdown.byCategory.food} / 景点 ¥${breakdown.byCategory.attractions} / 其他 ¥${breakdown.byCategory.other}${suggestions}

请调整行程(更换更便宜的酒店/减少付费景点/换经济餐厅),重新调用 finalize_plan。`;
}

export function applyFinalizePlan(
  state: AgentState,
  data: { plan: { dayPlans: PlanDayPlan[] }; breakdown: BudgetBreakdownV2; withinBudget: boolean },
): AgentState {
  const next: AgentState = {
    ...state,
    dayPlans: data.plan.dayPlans,
    budgetBreakdown: data.breakdown,
  };

  if (data.withinBudget) {
    return next;
  }

  if (state.budgetRound < MAX_BUDGET_ROUNDS && state.preferences) {
    return {
      ...next,
      budgetRound: state.budgetRound + 1,
      phase: "planning",
      _pendingBudgetFeedback: budgetExceedPrompt(data.breakdown, state.preferences),
    };
  }

  return {
    ...next,
    phase: "completed",
    errorMessages: [
      ...next.errorMessages,
      `Budget exceeded after ${MAX_BUDGET_ROUNDS} rounds, delivering best-effort plan`,
    ],
  };
}

export const TOOL_EFFECT_HANDLERS: Record<string, StateReducer> = {
  collect_preferences:      (s, d) => ({ ...s, preferences: mergePrefs(s.preferences, d) }),
  search_baike:             (s, d) => ({ ...s, baikeKnowledge: d.summary }),
  search_weather:           (s, d) => ({ ...s, weather: d }),
  search_attractions:       (s, d) => appendCandidates(s, "candidateAttractions", d.items ?? [], d.scores ?? {}),
  search_hotels:            (s, d) => appendCandidates(s, "candidateHotels", d.items ?? [], d.scores ?? {}),
  search_restaurants:       (s, d) => d.scope === "attraction"
                                       ? appendPlanningRestaurants(s, d.near ?? "(unknown)", d.items ?? [], d.scores ?? {})
                                       : appendCandidates(s, "candidateRestaurants", d.items ?? [], d.scores ?? {}),
  search_xhs:               (s, d) => mergeXhsNotes(s, d.notes ?? d.top ?? []),
  search_travel_guides:     (s) => s,
  select_transport:         (s, d) => ({ ...s, selectedOutbound: d.outbound, selectedReturn: d.return }),
  select_hotel:             (s, d) => ({ ...s, selectedHotel: d.hotel }),
  plan_transit:             (s, d) => appendTransit(s, d.dayIdx, d.transit),
  finalize_plan:            (s, d) => applyFinalizePlan(s, d),
};

export function applyToolEffects(state: AgentState, results: ToolResultLike[]): AgentState {
  let next = state;
  for (const result of results) {
    if (!result.success) {
      const fallbackUsage = result.fallbackLevel && result.fallbackLevel > 0
        ? {
            ...next.fallbackUsage,
            [result.toolName]: (next.fallbackUsage[result.toolName] ?? 0) + 1,
          }
        : next.fallbackUsage;
      next = {
        ...next,
        toolErrors: { ...next.toolErrors, [result.toolName]: result.error ?? "unknown" },
        fallbackUsage,
      };
      continue;
    }

    const handler = TOOL_EFFECT_HANDLERS[result.toolName];
    if (handler) {
      next = handler(next, result.data);
    }
  }
  return next;
}
