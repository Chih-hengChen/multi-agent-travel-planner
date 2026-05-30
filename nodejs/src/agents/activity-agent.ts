import type { Logger } from "pino";
import { TravelStyle, ActivitySubType, DINING_PRICE_BY_STYLE, TRANSIT_DAILY_COST, type Activity, type DayPlan, type ActivitySearchResult, type TravelPlanState } from "../types/index.js";
import { createRng, type Rng } from "../utils/prng.js";
import { computeSeed, agentSeed } from "../utils/seed.js";
import { BaseAgent } from "./base-agent.js";

const ATTRACTION_POOL: Array<Record<string, unknown>> = [
  { name: "城市地标打卡", durationHours: 2.0, price: 0, rating: 8.5, timeSlot: "morning" },
  { name: "博物馆参观", durationHours: 3.0, price: 80, rating: 8.8, timeSlot: "morning" },
  { name: "历史街区漫步", durationHours: 2.0, price: 0, rating: 7.5, timeSlot: "afternoon" },
  { name: "公园休闲", durationHours: 1.5, price: 0, rating: 7.0, timeSlot: "morning" },
  { name: "日落观景", durationHours: 1.0, price: 50, rating: 9.0, timeSlot: "evening" },
  { name: "手工艺体验", durationHours: 2.0, price: 120, rating: 8.5, timeSlot: "afternoon" },
  { name: "文化演出", durationHours: 2.0, price: 200, rating: 9.2, timeSlot: "evening" },
  { name: "购物街逛逛", durationHours: 2.0, price: 0, rating: 7.5, timeSlot: "afternoon" },
  { name: "当地市场探索", durationHours: 1.5, price: 0, rating: 8.0, timeSlot: "morning" },
  { name: "温泉/SPA体验", durationHours: 2.0, price: 180, rating: 9.0, timeSlot: "afternoon" },
];

const DINING_POOL: Array<Record<string, unknown>> = [
  { name: "当地特色早餐", mealType: "breakfast", style: "local", durationHours: 1.0, rating: 8.0 },
  { name: "街边小吃", mealType: "breakfast", style: "street", durationHours: 0.5, rating: 7.5 },
  { name: "特色午餐", mealType: "lunch", style: "restaurant", durationHours: 1.5, rating: 9.0 },
  { name: "快餐简餐", mealType: "lunch", style: "quick", durationHours: 1.0, rating: 7.0 },
  { name: "当地正餐", mealType: "dinner", style: "restaurant", durationHours: 2.0, rating: 9.0 },
  { name: "夜市美食", mealType: "dinner", style: "street", durationHours: 2.0, rating: 8.5 },
  { name: "米其林餐厅体验", mealType: "dinner", style: "fine_dining", durationHours: 2.5, rating: 9.5 },
];

function diningPrice(mealType: string, style: TravelStyle, rng: Rng): number {
  const prices = DINING_PRICE_BY_STYLE[style];
  const base = mealType === "breakfast" ? prices.breakfast
    : mealType === "lunch" ? prices.lunch
    : prices.dinner;
  const noise = 0.8 + rng.next() * 0.4;
  return Math.round(base * noise);
}

export class ActivityAgent extends BaseAgent {
  readonly name = "ActivityAgent";
  constructor(log: Logger) { super(log); }

  protected async execute(state: TravelPlanState): Promise<TravelPlanState> {
    const pref = state.preferences!;
    const dest = state.selectedDestination!;
    const baseSeed = computeSeed(pref.departureCity, dest.city, pref.startDate, pref.endDate, pref.budget);
    const seed = agentSeed(baseSeed, "activity", state.adjustmentRound);
    const rng = createRng(seed);

    const days = ActivityAgent.getTravelDays(pref.startDate, pref.endDate);
    const travelStyle = pref.travelStyle as TravelStyle;
    const transitCost = TRANSIT_DAILY_COST[travelStyle] ?? 40;

    let totalCost = 0;
    const dayPlans: DayPlan[] = [];

    for (const dateStr of days) {
      const plan = ActivityAgent.planOneDay(dateStr, dest.city, travelStyle, pref.interests, transitCost, rng);
      const dayCost = plan.activities.reduce((sum, a) => sum + a.price, 0) * pref.numTravelers;
      plan.dayCost = dayCost;
      totalCost += dayCost;
      dayPlans.push(plan);
    }

    state.activityResult = { dayPlans, totalActivityCost: totalCost };
    this.log.info({ agent: this.name, days: dayPlans.length, totalCost }, "行程生成完成");
    return state;
  }

  static getTravelDays(start: string, end: string): string[] {
    try {
      const d1 = new Date(start);
      const d2 = new Date(end);
      const count = Math.max(Math.round((d2.getTime() - d1.getTime()) / 86400000), 1);
      return Array.from({ length: count }, (_, i) => {
        const d = new Date(d1.getTime() + i * 86400000);
        return d.toISOString().slice(0, 10);
      });
    } catch { return ["2026-01-01", "2026-01-02", "2026-01-03"]; }
  }

  static planOneDay(
    date: string,
    city: string,
    travelStyle: TravelStyle,
    interests: string[],
    transitCost: number,
    rng: Rng,
  ): DayPlan {
    const activities: Activity[] = [];
    const shuffled = [...ATTRACTION_POOL].sort(() => rng.next() - 0.5);

    const morningAttr = pickBest(shuffled.filter((a) => a.timeSlot === "morning"), interests, rng);
    if (morningAttr) activities.push(makeActivity(morningAttr, city, date, "morning", ActivitySubType.ATTRACTION));

    activities.push(makeDining(DINING_POOL, city, date, "breakfast", travelStyle, rng));

    const afternoonAttr = pickBest(shuffled.filter((a) => a.timeSlot === "afternoon"), interests, rng);
    if (afternoonAttr) activities.push(makeActivity(afternoonAttr, city, date, "afternoon", ActivitySubType.ATTRACTION));

    activities.push(makeDining(DINING_POOL, city, date, "lunch", travelStyle, rng));

    const eveningAttr = pickBest(shuffled.filter((a) => a.timeSlot === "evening"), interests, rng);
    if (eveningAttr) activities.push(makeActivity(eveningAttr, city, date, "evening", ActivitySubType.ATTRACTION));

    activities.push(makeDining(DINING_POOL, city, date, "dinner", travelStyle, rng));

    activities.push({
      name: "市内交通",
      category: "transit",
      location: city,
      durationHours: 1.0,
      price: transitCost,
      rating: 8.0,
      description: `${date} 市内交通`,
      timeSlot: "morning",
      subType: ActivitySubType.TRANSIT,
    });

    return { date, activities, dayCost: 0 };
  }
}

function pickBest(
  candidates: Array<Record<string, unknown>>,
  interests: string[],
  rng: Rng,
): Record<string, unknown> | null {
  if (candidates.length === 0) return null;
  let best = candidates[0]!;
  let bestScore = -Infinity;
  for (const c of candidates) {
    const bonus = interests.reduce(
      (sum, tag) => sum + (((c.name as string).includes(tag) || String(c.category ?? "").includes(tag)) ? 2 : 0),
      0,
    );
    const s = (c.rating as number) + bonus + rng.next();
    if (s > bestScore) { bestScore = s; best = c; }
  }
  return best;
}

function makeActivity(
  template: Record<string, unknown>,
  city: string,
  date: string,
  slot: string,
  subType: ActivitySubType,
): Activity {
  return {
    name: template.name as string,
    category: (template.category as string) ?? "sightseeing",
    location: city,
    durationHours: template.durationHours as number,
    price: template.price as number,
    rating: template.rating as number,
    description: `${date} ${slot} - ${template.name}`,
    timeSlot: slot,
    subType,
  };
}

function makeDining(
  pool: Array<Record<string, unknown>>,
  city: string,
  date: string,
  mealType: string,
  travelStyle: TravelStyle,
  rng: Rng,
): Activity {
  const candidates = pool.filter((d) => d.mealType === mealType);
  const pick = candidates.length > 0 ? rng.pick(candidates) : pool[0]!;
  const price = diningPrice(mealType, travelStyle, rng);
  return {
    name: pick.name as string,
    category: "dining",
    location: city,
    durationHours: (pick.durationHours as number) ?? 1.0,
    price,
    rating: (pick.rating as number) ?? 8.0,
    description: `${date} ${mealType} - ${pick.name}`,
    timeSlot: mealType === "breakfast" ? "morning" : mealType === "lunch" ? "afternoon" : "evening",
    subType: ActivitySubType.DINING,
    mealType,
  };
}
