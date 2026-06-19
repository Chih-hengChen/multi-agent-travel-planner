import { settings } from "../../config/settings.js";
import { AmapSource } from "../../data-sources/amap-source.js";
import type { RegisteredTool } from "../types.js";
import type { RestaurantSearchParams } from "../../data-sources/types.js";
import { callAmap } from "../policy.js";

const CHAIN_BRANDS = new Set([
  "麦当劳", "肯德基", "星巴克", "海底捞",
  "必胜客", "汉堡王", "赛百味", "瑞幸咖啡", "蜜雪冰城",
]);

const LOCAL_SPECIALTY_KEYWORDS: Record<string, string[]> = {
  "北京": ["烤鸭", "涮肉", "豆汁", "卤煮", "炸酱面", "爆肚", "驴打滚", "糖葫芦"],
  "上海": ["小笼", "生煎", "本帮", "蟹壳", "黄鱼", "腌笃鲜", "排骨年糕"],
  "成都": ["火锅", "串串", "钵钵鸡", "担担面", "麻婆豆腐", "兔头", "龙抄手", "钟水饺"],
  "西安": ["肉夹馍", "羊肉泡馍", "biang", "凉皮", "葫芦头", "灌汤包"],
  "广州": ["早茶", "肠粉", "烧腊", "叉烧", "煲仔饭", "云吞", "白切鸡"],
  "东京": ["寿司", "拉面", "天妇罗", "鳗鱼", "居酒屋", "烧鸟", "味噌"],
  "京都": ["怀石", "汤豆腐", "抹茶", "荞麦"],
  "大阪": ["章鱼烧", "串炸", "御好烧", "寿司"],
};

function isLocalSpecialty(name: string, description: string, city: string): boolean {
  const keywords = LOCAL_SPECIALTY_KEYWORDS[city] ?? [];
  const haystack = `${name} ${description}`;
  return keywords.some(k => haystack.includes(k));
}

function scoreRestaurant(r: {
  name: string;
  description?: string;
  rating?: number;
}, city: string): number {
  const ratingScore = Math.min(1, (r.rating ?? 0) / 10);
  const specificityBoost = r.name && r.name.length >= 3 ? 0.10 : 0.05;
  const localBoost = isLocalSpecialty(r.name, r.description ?? "", city) ? 0.05 : 0;
  return Math.max(0, Math.min(1, ratingScore * 0.85 + specificityBoost + localBoost));
}

function enforceLocalDiversityCap<T extends { name: string; description?: string }>(
  items: T[],
  city: string,
  maxRatio = 0.6,
): T[] {
  const localCap = Math.ceil(items.length * maxRatio);
  let localCount = 0;
  return items.filter(r => {
    if (isLocalSpecialty(r.name, r.description ?? "", city)) {
      if (localCount >= localCap) return false;
      localCount++;
      return true;
    }
    return true;
  });
}

function withScores<T extends { name: string; description?: string; rating?: number }>(
  items: T[],
  city: string,
): Array<T & { rerankScore: number }> {
  return items.map(r => ({ ...r, rerankScore: scoreRestaurant(r, city) }));
}

export function createSearchRestaurantsTool(): RegisteredTool {
  return {
    name: "search_restaurants",
    description: "搜索餐厅。scope=city 获取城市热门餐厅画像;scope=attraction 搜景点周边 1500m 餐厅。过滤规则:排除连锁品牌、本地特色 ≤60%。",
    input_schema: {
      type: "object",
      properties: {
        city:       { type: "string", description: "城市名" },
        scope:      { type: "string", enum: ["city", "attraction"], description: "搜索范围", default: "city" },
        near:       { type: "string", description: "scope=attraction 时必填:景点名或地址" },
        mealType:   { type: "string", enum: ["breakfast", "lunch", "dinner", "any"], description: "餐型,默认 any", default: "any" },
        preference: { type: "string", enum: ["local_specialties", "trending", "mixed"], description: "餐饮偏好,默认 local_specialties", default: "local_specialties" },
        maxResults: { type: "number", description: "最多返回数,默认 8", default: 8 },
      },
      required: ["city"],
    },
    metadata: { category: "search", timeout: 15_000 },
    execute: async (input) => {
      const city = String(input.city ?? "");
      const scope = String(input.scope ?? "city");
      const maxResults = Number(input.maxResults) || 8;

      if (scope === "attraction") {
        return executeAttractionScope(city, String(input.near ?? ""), String(input.mealType ?? "any"), maxResults);
      }
      return executeCityScope(city, String(input.mealType ?? "any"), String(input.preference ?? "local_specialties"), maxResults);
    },
  };
}

async function executeCityScope(city: string, mealType: string, preference: string, maxResults: number) {
  const amap = new AmapSource();
  const mealTypeMap: Record<string, "breakfast" | "lunch" | "dinner"> = {
    breakfast: "breakfast", lunch: "lunch", dinner: "dinner", any: "lunch",
  };

  try {
    const { result: rawResults } = await callAmap(() => amap.searchRestaurants({
      city,
      mealType: mealTypeMap[mealType] ?? "lunch",
      diningPreference: preference as RestaurantSearchParams["diningPreference"],
      maxResults: Math.max(maxResults * 2, 16),
    }));

    const filtered = rawResults
      .filter(r => !CHAIN_BRANDS.has(r.name))
      .map(r => ({
        name: r.name,
        category: "restaurant" as const,
        location: { lat: r.geoLocation?.lat ?? 0, lng: r.geoLocation?.lon ?? 0, address: r.location },
        estimatedDurationMin: Math.round((r.durationHours ?? 1.5) * 60),
        estimatedCost: r.price,
        description: r.description ?? "",
        rating: r.rating,
        source: "amap" as const,
      }));

    const scored = withScores(filtered, city).sort((a, b) => b.rerankScore - a.rerankScore);
    const capped = enforceLocalDiversityCap(scored, city, 0.6).slice(0, maxResults);

    const scores: Record<string, number> = {};
    for (const r of capped) scores[r.name] = r.rerankScore;

    return {
      success: true,
      data: { scope: "city", items: capped, scores, total: capped.length },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, data: null, error: `城市餐厅搜索失败:${msg}` };
  }
}

async function executeAttractionScope(city: string, near: string, mealType: string, maxResults: number) {
  if (!near) {
    return { success: false, data: null, error: "scope=attraction 时必须提供 near 参数(景点名)" };
  }

  try {
    const coords = await geocodeNear(near, city);
    if (!coords) {
      return { success: false, data: null, error: `无法定位景点"${near}"` };
    }

    const keywords = mealType !== "any" ? mealType : "美食";
    const { result: data, waitMs } = await callAmap(async () => {
      const qs = new URLSearchParams({
        key: settings.AMAP_API_KEY,
        keywords,
        types: "050000",
        location: `${coords.lng},${coords.lat}`,
        radius: "1500",
        offset: String(Math.min(maxResults + 10, 25)),
        page: "1",
      });

      const resp = await fetch(`https://restapi.amap.com/v3/place/around?${qs}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) throw new Error(`高德周边搜索失败 (${resp.status})`);
      return resp.json() as Promise<{
        status: string;
        pois: Array<{ name: string; address: string; location: string; cost: string; rating: string }>;
        info?: string;
      }>;
    });

    if (data.status !== "1" || !data.pois?.length) {
      return { success: true, data: { scope: "attraction", near, items: [], scores: {}, total: 0, amapWaitMs: waitMs } };
    }

    const filtered = data.pois
      .filter(p => !CHAIN_BRANDS.has(p.name))
      .map(p => {
        const [lng, lat] = (p.location ?? "0,0").split(",").map(Number);
        return {
          name: p.name,
          category: "restaurant" as const,
          location: { lat, lng, address: p.address ?? "" },
          estimatedDurationMin: 60,
          estimatedCost: parseInt(p.cost) || 60,
          description: p.address ?? "",
          rating: parseFloat(p.rating) || 0,
          source: "amap" as const,
        };
      });

    const scored = withScores(filtered, city).sort((a, b) => b.rerankScore - a.rerankScore);
    const capped = enforceLocalDiversityCap(scored, city, 0.6).slice(0, maxResults);

    const scores: Record<string, number> = {};
    for (const r of capped) scores[r.name] = r.rerankScore;

    return {
      success: true,
      data: { scope: "attraction", near, items: capped, scores, total: capped.length, amapWaitMs: waitMs },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, data: null, error: `景点周边餐厅搜索失败:${msg}` };
  }
}

async function geocodeNear(name: string, city: string): Promise<{ lat: number; lng: number } | null> {
  const qs = new URLSearchParams({
    key: settings.AMAP_API_KEY,
    address: name,
    city,
  });

  try {
    const resp = await fetch(`https://restapi.amap.com/v3/geocode/geo?${qs}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { status: string; geocodes?: Array<{ location: string }> };
    if (data.status !== "1" || !data.geocodes?.length) return null;
    const [lng, lat] = data.geocodes[0].location.split(",").map(Number);
    return { lat, lng };
  } catch {
    return null;
  }
}
