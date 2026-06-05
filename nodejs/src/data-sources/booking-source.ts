import { settings } from "../config/settings.js";
import type { Hotel } from "../types/index.js";
import type { FlightSearchParams, HotelSearchParams, AttractionSearchParams, TrainSearchParams, RestaurantSearchParams, TravelDataSource } from "./types.js";

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

interface ApiHotel {
  hotel_name: string;
  class?: number;
  review_score?: number;
  min_total_price?: number;
  currencycode?: string;
  composite_price_breakdown?: {
    gross_amount_per_night?: { value?: number };
  };
  longitude?: number;
  latitude?: number;
}

async function enrichChineseNames(hotels: Hotel[], city: string): Promise<void> {
  if (!settings.AMAP_API_KEY || hotels.length === 0) return;
  try {
    const names = hotels.map((h) => h.name).join("|");
    const qs = new URLSearchParams({
      key: settings.AMAP_API_KEY,
      keywords: names,
      city,
      citylimit: "true",
      offset: "25",
      page: "1",
      extensions: "base",
    });
    const resp = await fetch(`https://restapi.amap.com/v3/place/text?${qs}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return;
    const data = await resp.json() as { status: string; pois?: { name: string }[] };
    if (data.status !== "1" || !data.pois?.length) return;

    const poiMap = new Map<string, string>();
    for (const poi of data.pois) {
      if (poi.name) poiMap.set(poi.name.toLowerCase(), poi.name);
    }

    for (const hotel of hotels) {
      const en = hotel.name.toLowerCase();
      for (const [cnLower, cnName] of poiMap) {
        if (en.includes(cnLower) || cnLower.includes(en.replace(/\s+/g, ""))) {
          hotel.name = cnName;
          break;
        }
      }
    }
  } catch {
    // Amap lookup failed, keep English names
  }
}

export class BookingSource implements TravelDataSource {
  async searchFlights(_params: FlightSearchParams): Promise<never[]> {
    return [];
  }

  async searchHotels(params: HotelSearchParams): Promise<Hotel[]> {
    try {
      if (!settings.RAPIDAPI_KEY) return [];

      const coords = getCoords(params.city);
      if (!coords) return [];

      const nights = Math.max(
        1,
        Math.round(
          (new Date(params.checkOut).getTime() - new Date(params.checkIn).getTime()) / 86_400_000,
        ),
      );

      const qs = new URLSearchParams({
        latitude: String(coords.lat),
        longitude: String(coords.lon),
        arrival_date: params.checkIn,
        departure_date: params.checkOut,
        adults: String(params.adults),
        room_qty: "1",
        units: "metric",
        currency_code: "CNY",
        languagecode: "zh-cn",
        page_number: "1",
        radius: "15",
      });
      if (params.maxPricePerNight) qs.set("price_max", String(Math.round(params.maxPricePerNight * nights)));

      const resp = await fetch(
        `https://${settings.RAPIDAPI_HOST}/api/v1/hotels/searchHotelsByCoordinates?${qs}`,
        {
          headers: {
            "X-RapidAPI-Key": settings.RAPIDAPI_KEY,
            "X-RapidAPI-Host": settings.RAPIDAPI_HOST,
          },
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Booking search failed (${resp.status}): ${text}`);
      }

      const body = await resp.json() as {
        status?: boolean;
        data?: { result?: ApiHotel[] };
      };

      const rawHotels = body.data?.result ?? [];

      const hotels: Hotel[] = rawHotels.map((h) => {
        const perNight = h.composite_price_breakdown?.gross_amount_per_night?.value
          ?? (h.min_total_price ? h.min_total_price / nights : 0);
        return {
          name: h.hotel_name ?? "",
          city: params.city,
          address: "",
          starRating: h.class ?? 3,
          userRating: (h.review_score ?? 0) / 2,
          pricePerNight: Math.round(perNight),
          amenities: [],
          distanceToCenterKm: 0,
        } as Hotel;
      });

      await enrichChineseNames(hotels, params.city);

      return hotels;
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

  async searchRestaurants(_params: RestaurantSearchParams): Promise<never[]> {
    return [];
  }
}
