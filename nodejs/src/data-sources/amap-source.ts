import { settings } from "../config/settings.js";
import type { Activity, GeoLocation, TransitRouteResult, TransitSegment } from "../types/index.js";
import { ActivitySubType } from "../types/index.js";
import type { FlightSearchParams, HotelSearchParams, AttractionSearchParams, TrainSearchParams, RestaurantSearchParams, TravelDataSource } from "./types.js";

const CATEGORY_MAP: Record<string, string> = {
  "自然风光": "自然风光|公园|植物园|风景区",
  "历史古迹": "历史古迹|古建筑|遗址|城墙|故宫|庙",
  "博物馆": "博物馆|展览馆|美术馆|科技馆",
  "购物": "购物中心|商场|步行街|商业街",
  "美食": "美食街|小吃街|餐饮",
  "夜生活": "酒吧街|夜市|演出",
  "主题乐园": "主题乐园|游乐园|水上乐园",
};

const AMAP_CITY_CODE: Record<string, string> = {
  "北京": "010", "上海": "021", "广州": "020", "深圳": "0755",
  "成都": "028", "杭州": "0571", "武汉": "027", "西安": "029",
  "重庆": "023", "南京": "025", "长沙": "0731", "青岛": "0532",
  "三亚": "0898", "厦门": "0592", "昆明": "0871", "天津": "022",
  "哈尔滨": "0451", "大连": "0411", "南宁": "0771", "贵阳": "0851",
  "桂林": "0773", "海口": "0898", "郑州": "0371", "福州": "0591",
};

function buildKeywords(interests?: string[]): string {
  if (!interests?.length) return "景点|旅游|公园";
  const mapped = interests.map((i) => CATEGORY_MAP[i] ?? i);
  return mapped.join("|");
}

const CITY_FOOD_MAP: Record<string, { breakfast: string; lunch: string; dinner: string }> = {
  "北京": { breakfast: "豆浆|油条|包子|豆汁", lunch: "烤鸭|涮肉|炸酱面|京菜", dinner: "烤鸭|涮羊肉|京味菜|老字号" },
  "成都": { breakfast: "担担面|龙抄手|钟水饺", lunch: "火锅|串串|川菜|麻婆豆腐", dinner: "火锅|川菜|串串香|钵钵鸡" },
  "上海": { breakfast: "生煎|小笼包|豆浆", lunch: "本帮菜|红烧肉|小笼", dinner: "本帮菜|蟹粉|红烧肉" },
  "广州": { breakfast: "早茶|肠粉|叉烧包", lunch: "粤菜|煲仔饭|烧腊", dinner: "粤菜|海鲜|煲汤" },
  "西安": { breakfast: "肉夹馍|胡辣汤|羊肉泡馍", lunch: "面食|biangbiang面|羊肉泡馍", dinner: "陕菜|肉夹馍|凉皮" },
  "重庆": { breakfast: "小面|酸辣粉", lunch: "火锅|江湖菜|辣子鸡", dinner: "火锅|烤鱼|江湖菜" },
};

const DINING_KEYWORDS: Record<string, Record<string, string>> = {
  trending: {
    breakfast: "网红早午餐|ins风咖啡厅|精品咖啡",
    lunch: "网红餐厅|小红书推荐|博主探店",
    dinner: "黑珍珠餐厅|必吃榜|热门餐厅|排队餐厅",
  },
  local_specialties: {
    breakfast: "当地早餐|特色早点|老字号早餐",
    lunch: "特色菜|地方菜|老字号",
    dinner: "当地美食|特色正餐|地道菜",
  },
  mixed: {
    breakfast: "早餐|早茶|咖啡厅",
    lunch: "午餐|餐厅|美食",
    dinner: "晚餐|正餐|美食街",
  },
};

function parseGeoLocation(location?: string): GeoLocation | undefined {
  if (!location) return undefined;
  const parts = location.split(",");
  if (parts.length !== 2) return undefined;
  const [lon, lat] = parts.map(Number);
  if (isNaN(lon) || isNaN(lat)) return undefined;
  return { lon, lat };
}

function parseCost(cost?: string): number {
  if (!cost) return 0;
  const nums = cost.match(/\d+/g);
  if (!nums?.length) return 0;
  return parseInt(nums[0]);
}

function buildTransitDescription(segments: TransitSegment[]): string {
  const parts: string[] = [];
  for (const seg of segments) {
    if (seg.type === "walking" && seg.distanceMeters > 0) {
      parts.push(`步行${seg.distanceMeters}m`);
    } else if (seg.type === "subway" || seg.type === "bus") {
      parts.push(`乘${seg.lineName ?? (seg.type === "subway" ? "地铁" : "公交")}`);
    }
  }
  return parts.join("→") || "公共交通";
}

interface AmapPoi {
  name: string;
  type?: string;
  address?: string;
  location?: string;
  rating?: string;
  cost?: string;
}

export class AmapSource implements TravelDataSource {
  /** 高德 API 限流：最大 3 QPS（个人开发者限制） */
  private static requestTimestamps: number[] = [];

  private static async throttle(): Promise<void> {
    const now = Date.now();
    const windowStart = now - 1000;
    AmapSource.requestTimestamps = AmapSource.requestTimestamps.filter(t => t > windowStart);
    if (AmapSource.requestTimestamps.length >= 3) {
      const waitMs = AmapSource.requestTimestamps[0] + 1000 - now;
      if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
    }
    AmapSource.requestTimestamps.push(Date.now());
  }

  async searchFlights(_params: FlightSearchParams): Promise<never[]> { return []; }
  async searchHotels(_params: HotelSearchParams): Promise<never[]> { return []; }
  async searchTrains(_params: TrainSearchParams): Promise<never[]> { return []; }

  async searchAttractions(params: AttractionSearchParams): Promise<Activity[]> {
    try {
      if (!settings.AMAP_API_KEY) throw new Error("AMAP_API_KEY 未配置");
      const keywords = params.query ?? buildKeywords(params.interests);
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

      await AmapSource.throttle();
      const resp = await fetch(`https://restapi.amap.com/v3/place/text?${qs}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) throw new Error(`高德 POI 搜索失败 (${resp.status})`);
      const data = await resp.json() as { status: string; pois: AmapPoi[]; info?: string };
      if (data.status !== "1") throw new Error(`高德 API 错误: ${data.info ?? "unknown"}`);

      return (data.pois ?? []).map((poi): Activity => ({
        name: poi.name,
        category: poi.type?.split(";")[0] ?? "景点",
        location: poi.address ?? params.city,
        durationHours: 2.0,
        price: parseCost(poi.cost),
        rating: parseFloat(poi.rating ?? "0") / 2,
        description: "",
        timeSlot: "",
        subType: "attraction" as ActivitySubType,
        geoLocation: parseGeoLocation(poi.location),
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[AmapSource] 景点搜索失败: ${msg}`);
      return [];
    }
  }

  async searchRestaurants(params: RestaurantSearchParams): Promise<Activity[]> {
    try {
      if (!settings.AMAP_API_KEY) throw new Error("AMAP_API_KEY 未配置");
      const pref = params.diningPreference ?? "mixed";
      let keywords: string;
      if (pref === "local_specialties" && CITY_FOOD_MAP[params.city]) {
        keywords = CITY_FOOD_MAP[params.city][params.mealType];
      } else {
        keywords = DINING_KEYWORDS[pref]?.[params.mealType] ?? "餐厅";
      }
      const maxResults = params.maxResults ?? 10;
      const timeSlot = params.mealType === "breakfast" ? "morning" : params.mealType === "lunch" ? "afternoon" : "evening";
      const durationHours = params.mealType === "breakfast" ? 1.0 : params.mealType === "lunch" ? 1.5 : 2.0;
      const fallbackPrice = params.mealType === "breakfast" ? 30 : params.mealType === "lunch" ? 60 : 80;

      const qs = new URLSearchParams({
        key: settings.AMAP_API_KEY,
        keywords,
        types: "050000",
        city: params.city,
        citylimit: "true",
        offset: String(Math.min(maxResults, 25)),
        page: "1",
        extensions: "all",
      });

      await AmapSource.throttle();
      const resp = await fetch(`https://restapi.amap.com/v3/place/text?${qs}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) throw new Error(`高德餐饮搜索失败 (${resp.status})`);
      const data = await resp.json() as { status: string; pois: AmapPoi[]; info?: string };
      if (data.status !== "1") throw new Error(`高德 API 错误: ${data.info ?? "unknown"}`);

      return (data.pois ?? []).map((poi): Activity => ({
        name: poi.name,
        category: "dining",
        location: poi.address ?? params.city,
        durationHours,
        price: parseCost(poi.cost) || fallbackPrice,
        rating: parseFloat(poi.rating ?? "0") / 2,
        description: "",
        timeSlot,
        subType: ActivitySubType.DINING,
        mealType: params.mealType,
        geoLocation: parseGeoLocation(poi.location),
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[AmapSource] 餐饮搜索失败: ${msg}`);
      return [];
    }
  }

  async planTransitRoute(origin: GeoLocation, destination: GeoLocation, city: string): Promise<TransitRouteResult | null> {
    try {
      const transit = await this.fetchTransitRoute(origin, destination, city);
      if (transit && transit.transfers <= 2 && transit.walkingDistanceMeters <= 1000) {
        return transit;
      }
      const driving = await this.fetchDrivingRoute(origin, destination);
      if (driving) return driving;
      return transit;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[AmapSource] 路线规划失败: ${msg}`);
      return null;
    }
  }

  private async fetchTransitRoute(origin: GeoLocation, destination: GeoLocation, city: string): Promise<TransitRouteResult | null> {
    const cityCode = AMAP_CITY_CODE[city];
    if (!cityCode) return null;

    const qs = new URLSearchParams({
      key: settings.AMAP_API_KEY,
      origin: `${origin.lon},${origin.lat}`,
      destination: `${destination.lon},${destination.lat}`,
      city1: cityCode,
      city2: cityCode,
      strategy: "2",
    });

    await AmapSource.throttle();
    const resp = await fetch(`https://restapi.amap.com/v5/direction/transit/integrated?${qs}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    if (data.status !== "1" || !data.transits?.length) return null;

    const plan = data.transits[0];
    const cost = parseFloat(plan.cost?.transit_fee ?? "0") || 0;
    const durationMin = Math.round(parseInt(plan.cost?.duration ?? "0") / 60) || 30;

    let totalWalking = 0;
    let rides = 0;
    const segments: TransitSegment[] = [];

    for (const seg of plan.segments ?? []) {
      if (seg.walking) {
        const walkDist = parseInt(seg.walking.distance ?? "0") || 0;
        totalWalking += walkDist;
        if (walkDist > 50) {
          segments.push({ type: "walking", distanceMeters: walkDist, durationMinutes: Math.round(walkDist / 80) });
        }
      }
      if (seg.bus?.buslines?.length) {
        const line = seg.bus.buslines[0];
        rides++;
        segments.push({
          type: "bus",
          lineName: line.name?.split("(")[0] ?? "公交",
          fromStop: line.departure_stop?.name,
          toStop: line.arrival_stop?.name,
          distanceMeters: parseInt(line.distance ?? "0") || 0,
          durationMinutes: Math.round(parseInt(line.duration ?? "0") / 60) || 10,
        });
      }
      if (seg.subway?.subwaylines?.length) {
        const line = seg.subway.subwaylines[0];
        rides++;
        segments.push({
          type: "subway",
          lineName: line.name?.split("(")[0] ?? "地铁",
          fromStop: line.departure_stop?.name,
          toStop: line.arrival_stop?.name,
          distanceMeters: parseInt(line.distance ?? "0") || 0,
          durationMinutes: Math.round(parseInt(line.duration ?? "0") / 60) || 10,
        });
      }
    }

    return {
      mode: segments.some((s) => s.type === "subway") ? "subway" : "bus",
      description: buildTransitDescription(segments),
      cost,
      durationMinutes: durationMin,
      walkingDistanceMeters: totalWalking,
      transfers: Math.max(0, rides - 1),
      segments,
    };
  }

  private async fetchDrivingRoute(origin: GeoLocation, destination: GeoLocation): Promise<TransitRouteResult | null> {
    const qs = new URLSearchParams({
      key: settings.AMAP_API_KEY,
      origin: `${origin.lon},${origin.lat}`,
      destination: `${destination.lon},${destination.lat}`,
      strategy: "32",
    });

    await AmapSource.throttle();
    const resp = await fetch(`https://restapi.amap.com/v5/direction/driving?${qs}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    if (data.status !== "1" || !data.route?.paths?.length) return null;

    const path = data.route.paths[0];
    const taxiCost = parseFloat(data.route.taxi_cost ?? "0") || parseFloat(path.cost?.taxi_fee ?? "0") || 0;
    const durationMin = Math.round(parseInt(path.cost?.duration ?? "0") / 60) || 20;

    return {
      mode: "taxi",
      description: `打车约¥${Math.round(taxiCost)}，${durationMin}分钟`,
      cost: Math.round(taxiCost),
      durationMinutes: durationMin,
      walkingDistanceMeters: 0,
      transfers: 0,
      segments: [{ type: "bus", lineName: "出租车/网约车", distanceMeters: parseInt(path.distance ?? "0") || 0, durationMinutes: durationMin }],
    };
  }
}
