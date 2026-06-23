import type { Logger } from "pino";
import { ActivitySubType, type Activity, type DayPlan, type ActivitySearchResult, type TravelPlanState, type UserPreferences, type GeoLocation } from "../types/index.js";
import type { TravelDataSource } from "../data-sources/types.js";
import { BaseAgent } from "./base-agent.js";

const FALLBACK_TRANSIT_COST = 40;

function haversineKm(a?: GeoLocation, b?: GeoLocation): number {
  if (!a || !b) return 99;
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

export class ActivityAgent extends BaseAgent {
  readonly name = "ActivityAgent";
  constructor(log: Logger, dataSource: TravelDataSource) { super(log, dataSource); }

  protected async execute(state: TravelPlanState): Promise<TravelPlanState> {
    const pref = state.preferences!;
    const dest = state.selectedDestination!;
    const days = ActivityAgent.getTravelDays(pref.startDate, pref.endDate);

    let mustVisitAttractions: Activity[] = [];
    if (pref.mustVisitAttractions?.length) {
      const results = await Promise.all(
        pref.mustVisitAttractions.map((name) =>
          this.dataSource.searchAttractions({ city: dest.city, query: name, maxResults: 3 }),
        ),
      );
      mustVisitAttractions = results.flat().filter((a, i, arr) =>
        arr.findIndex((b) => b.name === a.name) === i,
      );
    }

    const genericAttractions = await this.dataSource.searchAttractions({
      city: dest.city,
      interests: pref.interests,
      maxResults: days.length * 3,
    });

    const mustVisitNames = new Set(mustVisitAttractions.map((a) => a.name));
    const filteredGeneric = genericAttractions.filter((a) => !mustVisitNames.has(a.name));
    const attractions = [...mustVisitAttractions, ...filteredGeneric];

    const [breakfasts, lunches, dinners] = await Promise.all([
      this.dataSource.searchRestaurants({ city: dest.city, mealType: "breakfast", diningPreference: pref.diningPreference as any, maxResults: days.length * 2 }),
      this.dataSource.searchRestaurants({ city: dest.city, mealType: "lunch", diningPreference: pref.diningPreference as any, maxResults: days.length * 2 }),
      this.dataSource.searchRestaurants({ city: dest.city, mealType: "dinner", diningPreference: pref.diningPreference as any, maxResults: days.length * 2 }),
    ]);

    const maxPerDay = state.searchConstraints?.maxActivityCostPerDay;
    let totalCost = 0;
    const dayPlans: DayPlan[] = [];

    let attrIdx = 0;
    for (const dateStr of days) {
      const plan = await this.planOneDay(dateStr, dest.city, pref, attractions, attrIdx, breakfasts, lunches, dinners);
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
    breakfasts: Activity[],
    lunches: Activity[],
    dinners: Activity[],
  ): Promise<DayPlan> {
    const activities: Activity[] = [];

    const morningAttr = attractions[(startIdx) % attractions.length];
    if (morningAttr) {
      activities.push({ ...morningAttr, timeSlot: "morning", description: `${date} 上午 - ${morningAttr.name}` });
    }

    if (breakfasts.length > 0) {
      const b = breakfasts[startIdx % breakfasts.length];
      activities.push({ ...b, description: `${date} 早餐 - ${b.name}` });
    } else {
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
    }

    const afternoonAttr = attractions[(startIdx + 1) % attractions.length];
    if (afternoonAttr) {
      activities.push({ ...afternoonAttr, timeSlot: "afternoon", description: `${date} 下午 - ${afternoonAttr.name}` });
    }

    if (lunches.length > 0) {
      const l = lunches[startIdx % lunches.length];
      activities.push({ ...l, description: `${date} 午餐 - ${l.name}` });
    } else {
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
    }

    const eveningAttr = attractions[(startIdx + 2) % attractions.length];
    if (eveningAttr) {
      activities.push({ ...eveningAttr, timeSlot: "evening", description: `${date} 晚上 - ${eveningAttr.name}` });
    }

    if (dinners.length > 0) {
      const d = dinners[startIdx % dinners.length];
      activities.push({ ...d, description: `${date} 晚餐 - ${d.name}` });
    } else {
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
    }

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
    _localTransitMode: string,
  ): Promise<Activity[]> {
    if (locatedActivities.length < 2) return [];

    const transitActs: Activity[] = [];

    for (let i = 0; i < locatedActivities.length - 1; i++) {
      const from = locatedActivities[i]!;
      const to = locatedActivities[i + 1]!;
      const distKm = haversineKm(from.geoLocation, to.geoLocation);
      const distM = Math.round(distKm * 1000);

      if (distM < 800) {
        transitActs.push({
          name: "步行",
          category: "transit",
          location: city,
          durationHours: Math.round(distM / 500 * 4) / 4,
          price: 0,
          rating: 8.0,
          description: `${from.name} → ${to.name} 步行${distM}米`,
          timeSlot: from.timeSlot,
          subType: ActivitySubType.TRANSIT,
        });
        continue;
      }

      if (distM < 3000) {
        let walked = false;
        if (this.dataSource.planTransitRoute && from.geoLocation && to.geoLocation) {
          try {
            const route = await this.dataSource.planTransitRoute(from.geoLocation, to.geoLocation, city);
            if (route && (route.mode === "subway" || route.mode === "bus") && route.transfers <= 2) {
              transitActs.push({
                name: route.mode === "subway" ? "地铁出行" : "公交出行",
                category: "transit",
                location: city,
                durationHours: Math.round(route.durationMinutes / 15) / 4,
                price: route.cost,
                rating: 8.0,
                description: `${from.name} → ${to.name} ${route.description}`,
                timeSlot: from.timeSlot,
                subType: ActivitySubType.TRANSIT,
              });
              walked = true;
            }
          } catch { /* fall back to walking */ }
        }
        if (!walked) {
          transitActs.push({
            name: "步行",
            category: "transit",
            location: city,
            durationHours: Math.round(distM / 500 * 4) / 4,
            price: 0,
            rating: 8.0,
            description: `${from.name} → ${to.name} 步行${distM}米`,
            timeSlot: from.timeSlot,
            subType: ActivitySubType.TRANSIT,
          });
        }
        continue;
      }

      if (this.dataSource.planTransitRoute && from.geoLocation && to.geoLocation) {
        try {
          const route = await this.dataSource.planTransitRoute(from.geoLocation, to.geoLocation, city);
          if (route && (route.mode === "subway" || route.mode === "bus") && route.transfers <= 2) {
            transitActs.push({
              name: route.mode === "subway" ? "地铁出行" : "公交出行",
              category: "transit",
              location: city,
              durationHours: Math.round(route.durationMinutes / 15) / 4,
              price: route.cost,
              rating: 8.0,
              description: `${from.name} → ${to.name} ${route.description}`,
              timeSlot: from.timeSlot,
              subType: ActivitySubType.TRANSIT,
            });
            continue;
          }
          if (route) {
            transitActs.push({
              name: "打车",
              category: "transit",
              location: city,
              durationHours: Math.round(route.durationMinutes / 15) / 4,
              price: route.cost,
              rating: 8.0,
              description: `${from.name} → ${to.name} ${route.description}`,
              timeSlot: from.timeSlot,
              subType: ActivitySubType.TRANSIT,
            });
            continue;
          }
        } catch (err) {
          this.log.warn({ err }, "路线规划失败，降级为固定成本");
        }
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
