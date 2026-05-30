import { settings } from "../config/settings.js";
import type { Hotel } from "../types/index.js";
import type { FlightSearchParams, HotelSearchParams, AttractionSearchParams, TrainSearchParams, TravelDataSource } from "./types.js";

const CITY_COORDS: Record<string, { lat: number; lon: number }> = {
  "北京": { lat: 39.9042, lon: 116.4074 },
  "上海": { lat: 31.2304, lon: 121.4737 },
  "广州": { lat: 23.1291, lon: 113.2644 },
  "深圳": { lat: 22.5431, lon: 114.0579 },
  "成都": { lat: 30.5728, lon: 104.0668 },
  "杭州": { lat: 30.2741, lon: 120.1551 },
  "武汉": { lat: 30.5928, lon: 114.3055 },
  "西安": { lat: 34.3416, lon: 108.9398 },
  "重庆": { lat: 29.4316, lon: 106.9123 },
  "南京": { lat: 32.0603, lon: 118.7969 },
  "长沙": { lat: 28.2282, lon: 112.9388 },
  "青岛": { lat: 36.0671, lon: 120.3826 },
  "三亚": { lat: 18.2528, lon: 109.5120 },
  "厦门": { lat: 24.4798, lon: 118.0894 },
  "昆明": { lat: 25.0389, lon: 102.7183 },
  "东京": { lat: 35.6762, lon: 139.6503 },
  "大阪": { lat: 34.6937, lon: 135.5023 },
  "首尔": { lat: 37.5665, lon: 126.9780 },
  "曼谷": { lat: 13.7563, lon: 100.5018 },
  "新加坡": { lat: 1.3521, lon: 103.8198 },
  "香港": { lat: 22.3193, lon: 114.1694 },
  "巴黎": { lat: 48.8566, lon: 2.3522 },
  "伦敦": { lat: 51.5074, lon: -0.1278 },
  "纽约": { lat: 40.7128, lon: -74.0060 },
};

function getCoords(city: string): { lat: number; lon: number } | null {
  return CITY_COORDS[city] ?? null;
}

export class BookingSource implements TravelDataSource {
  async searchFlights(_params: FlightSearchParams): Promise<never[]> {
    return [];
  }

  async searchHotels(params: HotelSearchParams): Promise<Hotel[]> {
    try {
      if (!settings.RAPIDAPI_KEY) {
        throw new Error("RAPIDAPI_KEY 未配置");
      }
      const coords = getCoords(params.city);
      if (!coords) return [];

      const qs = new URLSearchParams({
        latitude: String(coords.lat),
        longitude: String(coords.lon),
        checkin: params.checkIn,
        checkout: params.checkOut,
        adults_number: String(params.adults),
        room_number: "1",
        units: "metric",
        order_by: "popularity",
        page_number: "0",
      });
      if (params.maxPricePerNight) qs.set("price_max", String(Math.round(params.maxPricePerNight)));

      const resp = await fetch(
        `https://booking-com.p.rapidapi.com/v1/hotels/search-by-coordinates?${qs}`,
        {
          headers: {
            "X-RapidAPI-Key": settings.RAPIDAPI_KEY,
            "X-RapidAPI-Host": "booking-com.p.rapidapi.com",
          },
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Booking.com search failed (${resp.status}): ${text}`);
      }
      const data = await resp.json() as {
        result: Array<{
          hotel_name: string;
          address?: string;
          class: number;
          review_score: number;
          min_total_price?: number;
          currencycode?: string;
          distance_to_cc?: string;
          hotel_facilities?: string[];
        }>;
      };

      const nights = Math.max(
        1,
        Math.round(
          (new Date(params.checkOut).getTime() - new Date(params.checkIn).getTime()) / 86_400_000,
        ),
      );

      return (data.result ?? []).map((h) => {
        const total = h.min_total_price ?? 0;
        const perNight = total > 0 ? Math.round(total / nights) : 0;
        return {
          name: h.hotel_name,
          city: params.city,
          address: h.address ?? "",
          starRating: h.class ?? 3,
          userRating: (h.review_score ?? 0) / 2,
          pricePerNight: perNight,
          amenities: (h.hotel_facilities ?? []).slice(0, 8),
          distanceToCenterKm: parseFloat(h.distance_to_cc?.replace(/[^\d.]/g, "") ?? "0") || 0,
        } satisfies Hotel;
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[BookingSource] 酒店搜索失败: ${msg}`);
      return [];
    }
  }

  async searchAttractions(_params: AttractionSearchParams): Promise<never[]> {
    return [];
  }

  async searchTrains(_params: TrainSearchParams): Promise<never[]> {
    return [];
  }
}
