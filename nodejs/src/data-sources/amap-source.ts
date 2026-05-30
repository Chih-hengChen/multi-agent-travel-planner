import { settings } from "../config/settings.js";
import type { Activity, ActivitySubType } from "../types/index.js";
import type { FlightSearchParams, HotelSearchParams, AttractionSearchParams, TrainSearchParams, TravelDataSource } from "./types.js";

const CATEGORY_MAP: Record<string, string> = {
  "自然风光": "自然风光|公园|植物园|风景区",
  "历史古迹": "历史古迹|古建筑|遗址|城墙|故宫|庙",
  "博物馆": "博物馆|展览馆|美术馆|科技馆",
  "购物": "购物中心|商场|步行街|商业街",
  "美食": "美食街|小吃街|餐饮",
  "夜生活": "酒吧街|夜市|演出",
  "主题乐园": "主题乐园|游乐园|水上乐园",
};

function buildKeywords(interests?: string[]): string {
  if (!interests?.length) return "景点|旅游|公园";
  const mapped = interests.map((i) => CATEGORY_MAP[i] ?? i);
  return mapped.join("|");
}

interface AmapPoi {
  name: string;
  type?: string;
  address?: string;
  location?: string;
  rating?: string;
  cost?: string;
  photos?: string;
}

export class AmapSource implements TravelDataSource {
  async searchFlights(_params: FlightSearchParams): Promise<never[]> {
    return [];
  }

  async searchHotels(_params: HotelSearchParams): Promise<never[]> {
    return [];
  }

  async searchAttractions(params: AttractionSearchParams): Promise<Activity[]> {
    try {
      if (!settings.AMAP_API_KEY) {
        throw new Error("AMAP_API_KEY 未配置");
      }
      const keywords = buildKeywords(params.interests);
      const maxResults = params.maxResults ?? 20;
      const qs = new URLSearchParams({
        key: settings.AMAP_API_KEY,
        keywords,
        city: params.city,
        citylimit: "true",
        offset: String(Math.min(maxResults, 25)),
        page: "1",
        extensions: "all",
      });

      const resp = await fetch(`https://restapi.amap.com/v3/place/text?${qs}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) {
        throw new Error(`高德 POI 搜索失败 (${resp.status})`);
      }
      const data = await resp.json() as {
        status: string;
        pois: AmapPoi[];
        info?: string;
      };
      if (data.status !== "1") {
        throw new Error(`高德 API 错误: ${data.info ?? "unknown"}`);
      }

      return (data.pois ?? []).map((poi) => ({
        name: poi.name,
        category: poi.type?.split(";")[0] ?? "景点",
        location: poi.address ?? params.city,
        durationHours: 2.0,
        price: parseCost(poi.cost),
        rating: parseFloat(poi.rating ?? "0") / 2,
        description: "",
        timeSlot: "",
        subType: "attraction" as ActivitySubType,
      }) satisfies Activity);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[AmapSource] 景点搜索失败: ${msg}`);
      return [];
    }
  }

  async searchTrains(_params: TrainSearchParams): Promise<never[]> {
    return [];
  }
}

function parseCost(cost?: string): number {
  if (!cost) return 0;
  const nums = cost.match(/\d+/g);
  if (!nums?.length) return 0;
  return parseInt(nums[0]);
}
