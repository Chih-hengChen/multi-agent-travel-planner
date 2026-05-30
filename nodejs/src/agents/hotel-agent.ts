import type { Logger } from "pino";
import type { Hotel, HotelSearchResult, TravelPlanState } from "../types/index.js";
import { createRng } from "../utils/prng.js";
import { computeSeed, agentSeed } from "../utils/seed.js";
import { BaseAgent } from "./base-agent.js";

const MOCK_HOTEL_TEMPLATES = [
  { name: "城市中心大酒店", starRating: 4.5, userRating: 9.0, basePrice: 600, amenities: ["WiFi", "早餐", "健身房", "泳池"], distance: 0.5 },
  { name: "经济快捷酒店", starRating: 3.0, userRating: 7.5, basePrice: 200, amenities: ["WiFi", "空调"], distance: 2.0 },
  { name: "精品设计酒店", starRating: 4.0, userRating: 8.8, basePrice: 450, amenities: ["WiFi", "早餐", "酒吧"], distance: 1.0 },
  { name: "豪华五星度假酒店", starRating: 5.0, userRating: 9.5, basePrice: 1200, amenities: ["WiFi", "早餐", "SPA", "泳池", "管家服务"], distance: 3.0 },
  { name: "青年旅舍", starRating: 2.0, userRating: 7.0, basePrice: 80, amenities: ["WiFi", "公共厨房"], distance: 1.5 },
  { name: "商务套房酒店", starRating: 4.0, userRating: 8.5, basePrice: 500, amenities: ["WiFi", "早餐", "会议室", "健身房"], distance: 0.8 },
];

export class HotelAgent extends BaseAgent {
  readonly name = "HotelAgent";
  constructor(log: Logger) { super(log); }

  protected async execute(state: TravelPlanState): Promise<TravelPlanState> {
    const pref = state.preferences!;
    const dest = state.selectedDestination!;
    const baseSeed = computeSeed(pref.departureCity, dest.city, pref.startDate, pref.endDate, pref.budget);
    const seed = agentSeed(baseSeed, "hotel", state.adjustmentRound);
    const rng = createRng(seed);

    const nights = HotelAgent.calcNights(pref.startDate, pref.endDate);
    let hotels = HotelAgent.generateHotels(dest.city, pref.travelStyle, rng);

    const constraints = state.searchConstraints;
    if (constraints) {
      if (constraints.maxHotelPricePerNight) {
        const cap = constraints.maxHotelPricePerNight;
        const filtered = hotels.filter((h) => h.pricePerNight <= cap);
        if (filtered.length > 0) hotels = filtered;
        else hotels = hotels.filter((h) => h.pricePerNight <= cap * 1.1);
      }
      if (constraints.maxHotelStarRating) {
        const filtered = hotels.filter((h) => h.starRating <= constraints.maxHotelStarRating!);
        if (filtered.length > 0) hotels = filtered;
      }
    }

    const rec = HotelAgent.bestHotel(hotels, (pref.budget * 0.4) / Math.max(nights, 1), pref.travelStyle);
    const rooms = Math.max(1, Math.ceil(pref.numTravelers / 2));
    const total = rec ? rec.pricePerNight * nights * rooms : 0;

    state.hotelResult = { hotels, recommended: rec, totalNights: nights, totalHotelCost: total };
    this.log.info({ agent: this.name, city: dest.city, hotel: rec?.name, total }, "酒店搜索完成");
    return state;
  }

  static calcNights(start: string, end: string): number {
    try {
      const d1 = new Date(start);
      const d2 = new Date(end);
      return Math.max(Math.round((d2.getTime() - d1.getTime()) / 86400000), 1);
    } catch { return 3; }
  }

  static generateHotels(city: string, style: string, rng: { next: () => number }): Hotel[] {
    const priceMult: Record<string, number> = {
      budget: 0.6, comfort: 1.0, luxury: 1.8,
      adventure: 0.7, cultural: 0.9, relaxation: 1.3,
    };
    const mult = priceMult[style] ?? 1.0;
    return MOCK_HOTEL_TEMPLATES.map((t) => {
      const noise = 0.8 + rng.next() * 0.4;
      return {
        name: `${city}${t.name}`,
        city,
        address: `${city}市中心区域`,
        starRating: t.starRating,
        userRating: t.userRating,
        pricePerNight: Math.round(t.basePrice * mult * noise),
        amenities: [...t.amenities],
        distanceToCenterKm: t.distance,
      };
    });
  }

  static bestHotel(hotels: Hotel[], nightlyBudget: number, style: string): Hotel | null {
    if (hotels.length === 0) return null;
    const starPref: Record<string, number> = {
      budget: 2.5, comfort: 3.5, luxury: 4.5,
      adventure: 2.5, cultural: 3.5, relaxation: 4.0,
    };
    const targetStar = starPref[style] ?? 3.5;

    const score = (h: Hotel): number => {
      const priceOk = h.pricePerNight <= nightlyBudget ? 20 : 0;
      const starFit = 30 - Math.abs(h.starRating - targetStar) * 10;
      const ratingS = h.userRating * 3;
      const distS = Math.max(0, 10 - h.distanceToCenterKm * 3);
      return priceOk + starFit + ratingS + distS;
    };

    return hotels.reduce((best, h) => (score(h) > score(best) ? h : best));
  }
}
