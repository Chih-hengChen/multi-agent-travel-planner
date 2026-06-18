import type { AgentState } from "../../runtime/state.js";
import { UNKNOWN_COST_AMOUNT } from "../../runtime/state.js";
import type { ToolResultLike } from "../../runtime/apply-tool-effects.js";
import {
  parsePlanLoose,
  JsonRepairExhaustedError,
  type TravelPlan,
  type PlanBudgetBreakdown,
  type PlanDayPlan,
} from "./plan-schema.js";

export interface FinalizePlanInput {
  rawJson: string;
}

export interface FinalizePlanResult {
  plan: { dayPlans: PlanDayPlan[] };
  breakdown: PlanBudgetBreakdown;
  withinBudget: boolean;
}

export function computeBudgetBreakdown(
  plan: TravelPlan,
  state: AgentState,
): PlanBudgetBreakdown {
  const byCategory = {
    transport: 0,
    accommodation: 0,
    food: 0,
    attractions: 0,
    other: 0,
  };

  for (const day of plan.dayPlans) {
    for (const slot of [day.morning, day.afternoon, day.evening]) {
      if (!slot) continue;
      for (const a of slot.attractions) {
        const cost = a.estimatedCost ?? 0;
        if (a.category === "attraction") byCategory.attractions += cost;
        else if (a.category === "restaurant") byCategory.food += cost;
        else if (a.category === "hotel") byCategory.accommodation += cost;
        else byCategory.other += cost;
      }
      const transitCost = slot.transitToNext?.costAmount ?? UNKNOWN_COST_AMOUNT;
      if (transitCost > 0) byCategory.transport += transitCost;
    }
    for (const d of day.dining) {
      if (d.restaurant?.estimatedCost) {
        byCategory.food += d.restaurant.estimatedCost;
      }
    }
  }

  const hotel = state.selectedHotel as { pricePerNight?: number } | undefined;
  if (hotel?.pricePerNight) {
    const startMs = new Date(state.preferences!.startDate).getTime();
    const endMs = new Date(state.preferences!.endDate).getTime();
    const nights = Math.max(1, Math.round((endMs - startMs) / 86_400_000));
    byCategory.accommodation += hotel.pricePerNight * nights;
  }

  const outboundCost = (state.selectedOutbound as { price?: number } | undefined)?.price ?? 0;
  const returnCost = (state.selectedReturn as { price?: number } | undefined)?.price ?? 0;
  const travelers = state.preferences?.numTravelers ?? 1;
  byCategory.transport += (outboundCost + returnCost) * travelers;

  const totalCost =
    byCategory.transport +
    byCategory.accommodation +
    byCategory.food +
    byCategory.attractions +
    byCategory.other;

  const budgetLimit = state.preferences?.budget ?? 0;

  return {
    totalCost,
    byCategory,
    budgetLimit,
    isWithinBudget: totalCost <= budgetLimit,
    variance: totalCost - budgetLimit,
    suggestions:
      totalCost > budgetLimit
        ? [
            `超预算 ¥${totalCost - budgetLimit}`,
            "可调整:更换更便宜的酒店 / 减少付费景点 / 选择经济餐厅",
          ]
        : undefined,
  };
}

export async function executeFinalizePlan(
  input: FinalizePlanInput,
  state: AgentState,
): Promise<ToolResultLike> {
  if (!state.preferences) {
    return {
      toolName: "finalize_plan",
      success: false,
      error: "preferences not set",
    };
  }

  let plan: TravelPlan;
  try {
    plan = parsePlanLoose(input.rawJson);
  } catch (err) {
    if (err instanceof JsonRepairExhaustedError) {
      return {
        toolName: "finalize_plan",
        success: false,
        error: `JSON repair exhausted: ${err.message}. Excerpt: ${err.rawExcerpt.slice(0, 200)}`,
      };
    }
    return {
      toolName: "finalize_plan",
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const breakdown = computeBudgetBreakdown(plan, state);

  return {
    toolName: "finalize_plan",
    success: true,
    data: {
      plan: { dayPlans: plan.dayPlans },
      breakdown,
      withinBudget: breakdown.isWithinBudget,
    } satisfies FinalizePlanResult,
    fallbackLevel: 0,
  };
}
