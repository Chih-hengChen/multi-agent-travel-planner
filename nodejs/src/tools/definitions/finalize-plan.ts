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

const CHAIN_BRANDS = new Set([
  "麦当劳", "肯德基", "星巴克", "海底捞",
  "必胜客", "汉堡王", "赛百味", "瑞幸咖啡", "蜜雪冰城",
]);

const LOCAL_SPECIALTY_KEYWORDS: Record<string, string[]> = {
  "北京": ["烤鸭", "涮肉", "豆汁", "卤煮", "炸酱面", "爆肚"],
  "上海": ["小笼", "生煎", "本帮", "蟹壳", "黄鱼", "腌笃鲜"],
  "成都": ["火锅", "串串", "钵钵鸡", "担担面", "麻婆豆腐", "兔头"],
  "西安": ["肉夹馍", "羊肉泡馍", "biang", "凉皮", "葫芦头"],
  "广州": ["早茶", "肠粉", "烧腊", "叉烧", "煲仔饭", "云吞"],
  "东京": ["寿司", "拉面", "天妇罗", "鳗鱼", "居酒屋", "烧鸟"],
  "京都": ["怀石", "汤豆腐", "抹茶", "荞麦"],
  "大阪": ["章鱼烧", "串炸", "御好烧"],
};

function isLocalSpecialty(name: string, description: string, city: string): boolean {
  const keywords = LOCAL_SPECIALTY_KEYWORDS[city] ?? [];
  const haystack = `${name} ${description}`;
  return keywords.some(k => haystack.includes(k));
}

function isTravelDay(dayIdx: number, state: AgentState): boolean {
  const prefs = state.preferences;
  if (!prefs?.startDate || !prefs?.endDate) return false;
  const startMs = new Date(prefs.startDate).getTime();
  const endMs = new Date(prefs.endDate).getTime();
  const daysDiff = Math.max(1, Math.round((endMs - startMs) / 86_400_000));
  return dayIdx === 0 || dayIdx === daysDiff;
}

function validatePlanQuality(plan: TravelPlan, state: AgentState): string[] {
  const errors: string[] = [];
  const city = state.preferences?.preferredDestination ?? "";

  for (const day of plan.dayPlans) {
    if (day.morning && !day.morning.transitFromPrev) {
      errors.push(`第 ${day.dayIdx + 1} 天缺酒店→早间交通(transitFromPrev)`);
    }
    if (day.morning && day.afternoon && !day.morning.transitToNext) {
      errors.push(`第 ${day.dayIdx + 1} 天 morning→afternoon 缺 transitToNext`);
    }
    if (day.afternoon && day.evening && !day.afternoon.transitToNext) {
      errors.push(`第 ${day.dayIdx + 1} 天 afternoon→evening 缺 transitToNext`);
    }
    if (day.evening && !day.evening.transitToNext) {
      errors.push(`第 ${day.dayIdx + 1} 天晚间缺→酒店交通(transitToNext)`);
    }

    const allActivities = [
      ...(day.morning?.attractions ?? []),
      ...(day.afternoon?.attractions ?? []),
      ...(day.evening?.attractions ?? []),
      ...day.dining.map(d => d.restaurant).filter(Boolean) as PlanDayPlan["dining"][number]["restaurant"][],
    ];

    for (const a of allActivities) {
      if (!a) continue;
      if (CHAIN_BRANDS.has(a.name)) {
        errors.push(`第 ${day.dayIdx + 1} 天出现连锁品牌"${a.name}"(除非用户显式要求)`);
      }
    }

    if (isTravelDay(day.dayIdx, state)) {
      for (const slot of [day.morning, day.afternoon, day.evening]) {
        if (!slot) continue;
        for (const a of slot.attractions) {
          const isFullDay = a.visitGuide?.isFullDay === true || (a.estimatedDurationMin ?? 0) >= 360;
          if (isFullDay && a.category === "attraction") {
            errors.push(`第 ${day.dayIdx + 1} 天有航班/火车但安排了全天景点"${a.name}"`);
          }
        }
      }
    }
  }

  if (city) {
    const allRestaurants = plan.dayPlans.flatMap(d =>
      (d.dining ?? []).map(x => x.restaurant).filter(Boolean) as PlanDayPlan["dining"][number]["restaurant"][],
    );
    if (allRestaurants.length > 0) {
      const localCount = allRestaurants.filter(r =>
        r && isLocalSpecialty(r.name, r.description ?? "", city),
      ).length;
      const ratio = localCount / allRestaurants.length;
      if (ratio > 0.6) {
        errors.push(`本地特色占比 ${(ratio * 100).toFixed(0)}% > 60%(共 ${allRestaurants.length} 家,本地 ${localCount} 家)`);
      }
    }
  }

  return errors;
}

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
        _jsonRepairError: true,
      };
    }
    return {
      toolName: "finalize_plan",
      success: false,
      error: err instanceof Error ? err.message : String(err),
      _jsonRepairError: true,
    };
  }

  const breakdown = computeBudgetBreakdown(plan, state);

  const qualityErrors = validatePlanQuality(plan, state);
  if (qualityErrors.length > 0) {
    return {
      toolName: "finalize_plan",
      success: false,
      error: `行程质量自检未通过,请修正后重新输出完整 JSON:\n${qualityErrors.map((e, i) => `${i + 1}. ${e}`).join("\n")}`,
      _jsonRepairError: true,
    };
  }

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
