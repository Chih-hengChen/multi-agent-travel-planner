import type { Logger } from "pino";
import { TravelStyle, type Hotel, type HotelSearchResult, type TravelPlanState, type UserPreferences } from "../types/index.js";
import type { TravelDataSource } from "../data-sources/types.js";
import { BaseAgent } from "./base-agent.js";

export class HotelAgent extends BaseAgent {
  readonly name = "HotelAgent";
  constructor(log: Logger, dataSource: TravelDataSource) { super(log, dataSource); }

  protected async execute(state: TravelPlanState): Promise<TravelPlanState> {
    const pref = state.preferences!;
    const dest = state.selectedDestination!;
    const nights = HotelAgent.calcNights(pref.startDate, pref.endDate);

    if (pref.selectedHotel) {
      const rooms = Math.max(1, Math.ceil(pref.numTravelers / 2));
      const total = pref.selectedHotel.pricePerNight * nights * rooms;
      state.hotelResult = {
        hotels: [pref.selectedHotel],
        recommended: pref.selectedHotel,
        totalNights: nights,
        totalHotelCost: total,
      };
      this.log.info({ agent: this.name, city: dest.city, hotel: pref.selectedHotel.name, total }, "使用用户选择的酒店");
      return state;
    }

    let hotels = await this.dataSource.searchHotels({
      city: dest.city,
      checkIn: pref.startDate,
      checkOut: pref.endDate,
      adults: pref.numTravelers,
      maxPricePerNight: state.searchConstraints?.maxHotelPricePerNight,
      maxStarRating: state.searchConstraints?.maxHotelStarRating,
    });

    if (hotels.length === 0) {
      this.log.warn({ agent: this.name, city: dest.city }, "未找到酒店");
    }

    const rec = HotelAgent.bestHotel(hotels, (pref.budget * 0.4) / Math.max(nights, 1), pref);
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

  static bestHotel(hotels: Hotel[], nightlyBudget: number, pref: UserPreferences): Hotel | null {
    if (hotels.length === 0) return null;
    const starByStyle: Record<string, number> = {
      budget: 2.5, comfort: 3.5, luxury: 4.5,
      adventure: 2.5, cultural: 3.5, relaxation: 4.0,
    };
    const targetStar = pref.preferredStarRating ?? starByStyle[pref.travelStyle] ?? 3.5;

    const score = (h: Hotel): number => {
      const priceOk = h.pricePerNight <= nightlyBudget ? 20 : 0;
      const starFit = 30 - Math.abs(h.starRating - targetStar) * 10;
      const ratingS = h.userRating * 3;
      const distS = Math.max(0, 10 - h.distanceToCenterKm * 3);
      let brandBonus = 0;
      if (pref.preferredHotelBrands.length > 0) {
        const nameLc = h.name.toLowerCase();
        if (pref.preferredHotelBrands.some(b => nameLc.includes(b.toLowerCase()))) brandBonus = 15;
      }
      return priceOk + starFit + ratingS + distS + brandBonus;
    };

    return hotels.reduce((best, h) => (score(h) > score(best) ? h : best));
  }
}
