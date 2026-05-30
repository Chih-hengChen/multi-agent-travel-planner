import type { Logger } from "pino";
import { TravelStyle, ActivitySubType, DINING_PRICE_BY_STYLE, TRANSIT_DAILY_COST, type Activity, type DayPlan, type ActivitySearchResult, type TravelPlanState } from "../types/index.js";
import type { TravelDataSource } from "../data-sources/types.js";
import { BaseAgent } from "./base-agent.js";

const DINING_TEMPLATES = [
  { name: "当地特色早餐", mealType: "breakfast", durationHours: 1.0, rating: 8.0 },
  { name: "街边小吃", mealType: "breakfast", durationHours: 0.5, rating: 7.5 },
  { name: "特色午餐", mealType: "lunch", durationHours: 1.5, rating: 9.0 },
  { name: "快餐简餐", mealType: "lunch", durationHours: 1.0, rating: 7.0 },
  { name: "当地正餐", mealType: "dinner", durationHours: 2.0, rating: 9.0 },
  { name: "夜市美食", mealType: "dinner", durationHours: 2.0, rating: 8.5 },
  { name: "米其林餐厅体验", mealType: "dinner", durationHours: 2.5, rating: 9.5 },
];

function diningPrice(mealType: string, style: TravelStyle): number {
  const prices = DINING_PRICE_BY_STYLE[style];
  return mealType === "breakfast" ? prices.breakfast
    : mealType === "lunch" ? prices.lunch
    : prices.dinner;
}

export class ActivityAgent extends BaseAgent {
  readonly name = "ActivityAgent";
  constructor(log: Logger, dataSource: TravelDataSource) { super(log, dataSource); }

  protected async execute(state: TravelPlanState): Promise<TravelPlanState> {
    const pref = state.preferences!;
    const dest = state.selectedDestination!;
    const days = ActivityAgent.getTravelDays(pref.startDate, pref.endDate);
    const travelStyle = pref.travelStyle as TravelStyle;
    const transitCost = TRANSIT_DAILY_COST[travelStyle] ?? 40;

    const attractions = await this.dataSource.searchAttractions({
      city: dest.city,
      interests: pref.interests,
      maxResults: days.length * 3,
    });

    const maxPerDay = state.searchConstraints?.maxActivityCostPerDay;
    let totalCost = 0;
    const dayPlans: DayPlan[] = [];

    let attrIdx = 0;
    for (const dateStr of days) {
      const plan = ActivityAgent.planOneDay(dateStr, dest.city, travelStyle, attractions, attrIdx, transitCost);
      if (maxPerDay) {
        let dayActivityCost = plan.activities.reduce((s, a) => s + a.price, 0);
        while (dayActivityCost > maxPerDay && plan.activities.length > 2) {
          const mostExpensive = plan.activities
            .filter((a) => a.subType === ActivitySubType.ATTRACTION)
            .sort((a, b) => b.price - a.price)[0];
          if (mostExpensive) {
            plan.activities.splice(plan.activities.indexOf(mostExpensive), 1);
            dayActivityCost = plan.activities.reduce((s, a) => s + a.price, 0);
          } else break;
        }
      }
      const dayCost = plan.activities.reduce((sum, a) => sum + a.price, 0) * pref.numTravelers;
      plan.dayCost = dayCost;
      totalCost += dayCost;
      dayPlans.push(plan);
      attrIdx += 3;
    }

    state.activityResult = { dayPlans, totalActivityCost: totalCost };
    this.log.info({ agent: this.name, days: dayPlans.length, totalCost, attractions: attractions.length }, "行程生成完成");
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
    attractions: Activity[],
    startIdx: number,
    transitCost: number,
  ): DayPlan {
    const activities: Activity[] = [];

    const morningAttr = attractions[(startIdx) % attractions.length];
    if (morningAttr) {
      activities.push({ ...morningAttr, timeSlot: "morning", description: `${date} 上午 - ${morningAttr.name}` });
    }

    activities.push(makeDining(city, date, "breakfast", travelStyle));

    const afternoonAttr = attractions[(startIdx + 1) % attractions.length];
    if (afternoonAttr) {
      activities.push({ ...afternoonAttr, timeSlot: "afternoon", description: `${date} 下午 - ${afternoonAttr.name}` });
    }

    activities.push(makeDining(city, date, "lunch", travelStyle));

    const eveningAttr = attractions[(startIdx + 2) % attractions.length];
    if (eveningAttr) {
      activities.push({ ...eveningAttr, timeSlot: "evening", description: `${date} 晚上 - ${eveningAttr.name}` });
    }

    activities.push(makeDining(city, date, "dinner", travelStyle));

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

function makeDining(city: string, date: string, mealType: string, travelStyle: TravelStyle): Activity {
  const candidates = DINING_TEMPLATES.filter((d) => d.mealType === mealType);
  const pick = candidates[Math.floor(Math.random() * candidates.length)] ?? DINING_TEMPLATES[0]!;
  const price = diningPrice(mealType, travelStyle);
  return {
    name: pick.name,
    category: "dining",
    location: city,
    durationHours: pick.durationHours,
    price,
    rating: pick.rating,
    description: `${date} ${mealType} - ${pick.name}`,
    timeSlot: mealType === "breakfast" ? "morning" : mealType === "lunch" ? "afternoon" : "evening",
    subType: ActivitySubType.DINING,
    mealType,
  };
}
