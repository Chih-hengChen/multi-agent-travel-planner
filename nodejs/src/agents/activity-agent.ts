import type { Logger } from "pino";
import { ActivitySubType, type Activity, type DayPlan, type ActivitySearchResult, type TravelPlanState, type UserPreferences } from "../types/index.js";
import type { TravelDataSource } from "../data-sources/types.js";
import { BaseAgent } from "./base-agent.js";

const FALLBACK_TRANSIT_COST = 40;

export class ActivityAgent extends BaseAgent {
  readonly name = "ActivityAgent";
  constructor(log: Logger, dataSource: TravelDataSource) { super(log, dataSource); }

  protected async execute(state: TravelPlanState): Promise<TravelPlanState> {
    const pref = state.preferences!;
    const dest = state.selectedDestination!;
    const days = ActivityAgent.getTravelDays(pref.startDate, pref.endDate);

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
      const plan = await this.planOneDay(dateStr, dest.city, pref, attractions, attrIdx);
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

  private async planOneDay(
    date: string,
    city: string,
    pref: UserPreferences,
    attractions: Activity[],
    startIdx: number,
  ): Promise<DayPlan> {
    const activities: Activity[] = [];

    const morningAttr = attractions[(startIdx) % attractions.length];
    if (morningAttr) {
      activities.push({ ...morningAttr, timeSlot: "morning", description: `${date} 上午 - ${morningAttr.name}` });
    }

    activities.push({
      name: "早餐",
      category: "dining",
      location: city,
      durationHours: 1.0,
      price: 30,
      rating: 8.0,
      description: `${date} 早餐`,
      timeSlot: "morning",
      subType: ActivitySubType.DINING,
      mealType: "breakfast",
    });

    const afternoonAttr = attractions[(startIdx + 1) % attractions.length];
    if (afternoonAttr) {
      activities.push({ ...afternoonAttr, timeSlot: "afternoon", description: `${date} 下午 - ${afternoonAttr.name}` });
    }

    activities.push({
      name: "午餐",
      category: "dining",
      location: city,
      durationHours: 1.5,
      price: 60,
      rating: 8.0,
      description: `${date} 午餐`,
      timeSlot: "afternoon",
      subType: ActivitySubType.DINING,
      mealType: "lunch",
    });

    const eveningAttr = attractions[(startIdx + 2) % attractions.length];
    if (eveningAttr) {
      activities.push({ ...eveningAttr, timeSlot: "evening", description: `${date} 晚上 - ${eveningAttr.name}` });
    }

    activities.push({
      name: "晚餐",
      category: "dining",
      location: city,
      durationHours: 2.0,
      price: 80,
      rating: 8.0,
      description: `${date} 晚餐`,
      timeSlot: "evening",
      subType: ActivitySubType.DINING,
      mealType: "dinner",
    });

    const transitActivities = await this.buildTransitSegments(
      activities.filter((a) => a.geoLocation), city, date, FALLBACK_TRANSIT_COST, pref.localTransitMode,
    );
    activities.push(...transitActivities);

    if (transitActivities.length === 0) {
      activities.push({
        name: "市内交通",
        category: "transit",
        location: city,
        durationHours: 1.0,
        price: FALLBACK_TRANSIT_COST,
        rating: 8.0,
        description: `${date} 市内交通`,
        timeSlot: "morning",
        subType: ActivitySubType.TRANSIT,
      });
    }

    return { date, activities, dayCost: 0 };
  }

  private async buildTransitSegments(
    locatedActivities: Activity[],
    city: string,
    date: string,
    fallbackCost: number,
    localTransitMode: string,
  ): Promise<Activity[]> {
    if (locatedActivities.length < 2) return [];

    if (localTransitMode === "rental_car") {
      return [{
        name: "租车自驾",
        category: "transit",
        location: city,
        durationHours: 1.0,
        price: Math.round(fallbackCost * 0.8),
        rating: 8.0,
        description: `${date} 租车自驾`,
        timeSlot: "morning",
        subType: ActivitySubType.TRANSIT,
      }];
    }

    if (localTransitMode === "taxi") {
      const segs: Activity[] = [];
      for (let i = 0; i < locatedActivities.length - 1; i++) {
        const from = locatedActivities[i]!;
        segs.push({
          name: "打车",
          category: "transit",
          location: city,
          durationHours: 0.5,
          price: Math.round(fallbackCost / 3),
          rating: 8.0,
          description: `${from.name} → ${locatedActivities[i + 1]!.name}`,
          timeSlot: from.timeSlot,
          subType: ActivitySubType.TRANSIT,
        });
      }
      return segs;
    }

    if (!this.dataSource.planTransitRoute) return [];

    const transitActs: Activity[] = [];

    for (let i = 0; i < locatedActivities.length - 1; i++) {
      const from = locatedActivities[i]!;
      const to = locatedActivities[i + 1]!;
      if (!from.geoLocation || !to.geoLocation) continue;

      try {
        const route = await this.dataSource.planTransitRoute(from.geoLocation, to.geoLocation, city);
        if (route) {
          transitActs.push({
            name: route.mode === "taxi" ? "打车" : route.mode === "subway" ? "地铁出行" : "公交出行",
            category: "transit",
            location: city,
            durationHours: Math.round(route.durationMinutes / 15) / 4,
            price: route.cost,
            rating: 8.0,
            description: route.description,
            timeSlot: from.timeSlot,
            subType: ActivitySubType.TRANSIT,
          });
          continue;
        }
      } catch (err) {
        this.log.warn({ err }, "路线规划失败，降级为固定成本");
      }

      transitActs.push({
        name: "市内交通",
        category: "transit",
        location: city,
        durationHours: 0.5,
        price: Math.round(fallbackCost / 3),
        rating: 8.0,
        description: `${from.name} → ${to.name}`,
        timeSlot: from.timeSlot,
        subType: ActivitySubType.TRANSIT,
      });
    }

    return transitActs;
  }
}
