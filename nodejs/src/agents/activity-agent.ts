import type { Logger } from "pino";
import type { Activity, DayPlan, ActivitySearchResult, TravelPlanState } from "../types/index.js";
import { BaseAgent } from "./base-agent.js";

const MOCK_ACTIVITIES_DB: Record<string, Array<Record<string, unknown>>> = {
  default: [
    { name: "城市地标打卡", category: "sightseeing", durationHours: 2.0, price: 0, rating: 8.5, timeSlot: "morning" },
    { name: "当地市场探索", category: "food", durationHours: 1.5, price: 100, rating: 8.0, timeSlot: "morning" },
    { name: "博物馆参观", category: "sightseeing", durationHours: 3.0, price: 80, rating: 8.8, timeSlot: "morning" },
    { name: "特色午餐", category: "food", durationHours: 1.5, price: 150, rating: 9.0, timeSlot: "afternoon" },
    { name: "历史街区漫步", category: "sightseeing", durationHours: 2.0, price: 0, rating: 7.5, timeSlot: "afternoon" },
    { name: "手工艺体验", category: "experience", durationHours: 2.0, price: 200, rating: 8.5, timeSlot: "afternoon" },
    { name: "日落观景", category: "sightseeing", durationHours: 1.0, price: 50, rating: 9.0, timeSlot: "evening" },
    { name: "当地夜市美食", category: "food", durationHours: 2.0, price: 120, rating: 8.5, timeSlot: "evening" },
    { name: "文化演出", category: "experience", durationHours: 2.0, price: 300, rating: 9.2, timeSlot: "evening" },
    { name: "温泉/SPA体验", category: "experience", durationHours: 2.0, price: 350, rating: 9.0, timeSlot: "afternoon" },
    { name: "公园休闲", category: "sightseeing", durationHours: 1.5, price: 0, rating: 7.0, timeSlot: "morning" },
    { name: "购物街逛逛", category: "experience", durationHours: 2.0, price: 0, rating: 7.5, timeSlot: "afternoon" },
  ],
};

export class ActivityAgent extends BaseAgent {
  readonly name = "ActivityAgent";
  constructor(log: Logger) { super(log); }

  protected async execute(state: TravelPlanState): Promise<TravelPlanState> {
    const pref = state.preferences;
    const dest = state.selectedDestination;
    if (!pref || !dest) throw new Error("缺少偏好或目的地信息");

    const days = ActivityAgent.getTravelDays(pref.startDate, pref.endDate);
    const pool = ActivityAgent.getActivityPool(dest.city);

    let totalCost = 0;
    const dayPlans: DayPlan[] = [];

    for (const dateStr of days) {
      const plan = ActivityAgent.planOneDay(dateStr, pool, pref.interests);
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

  static getActivityPool(city: string): Array<Record<string, unknown>> {
    const pool = MOCK_ACTIVITIES_DB[city] ?? MOCK_ACTIVITIES_DB["default"]!;
    return pool.map((a) => ({ ...a, location: city }));
  }

  static planOneDay(date: string, pool: Array<Record<string, unknown>>, interests: string[]): DayPlan {
    const slots = ["morning", "afternoon", "evening"];
    const activities: Activity[] = [];

    for (const slot of slots) {
      const candidates = pool.filter((a) => a.timeSlot === slot);
      if (candidates.length === 0) continue;

      let bestCandidate = candidates[0]!;
      let bestScore = -Infinity;

      for (const c of candidates) {
        const bonus = interests.reduce(
          (sum, tag) => sum + (((c.name as string).includes(tag) || (c.category as string).includes(tag)) ? 2 : 0),
          0,
        );
        const s = (c.rating as number) + bonus + Math.random();
        if (s > bestScore) { bestScore = s; bestCandidate = c; }
      }

      activities.push({
        name: bestCandidate.name as string,
        category: bestCandidate.category as string,
        location: (bestCandidate.location as string) ?? "",
        durationHours: bestCandidate.durationHours as number,
        price: bestCandidate.price as number,
        rating: bestCandidate.rating as number,
        description: `${date} ${slot} - ${bestCandidate.name}`,
        timeSlot: slot,
      });
    }

    return { date, activities, dayCost: 0 };
  }
}
