import { settings } from "../../config/settings.js";
import { AmapSource } from "../../data-sources/amap-source.js";
import type { RegisteredTool } from "../types.js";
import type { RestaurantSearchParams } from "../../types/index.js";

const CHAIN_BRANDS = new Set(["麦当劳", "肯德基", "星巴克", "海底捞", "必胜客", "汉堡王", "赛百味", "瑞幸咖啡", "蜜雪冰城"]);

export function createSearchRestaurantsTool(): RegisteredTool {
  return {
    name: "search_restaurants",
    description: "搜索餐厅。scope=city 获取城市热门餐厅画像;scope=attraction 搜景点周边 1500m 餐厅。过滤规则:排除连锁品牌、本地特色控制比例。",
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

      if (scope === "attraction") {
        return executeAttractionScope(city, String(input.near ?? ""), String(input.mealType ?? "any"), Number(input.maxResults) || 8);
      }
      return executeCityScope(city, String(input.mealType ?? "any"), String(input.preference ?? "local_specialties"), Number(input.maxResults) || 8);
    },
  };
}

async function executeCityScope(city: string, mealType: string, preference: string, maxResults: number) {
  const amap = new AmapSource();
  const mealTypeMap: Record<string, "breakfast" | "lunch" | "dinner"> = {
    breakfast: "breakfast", lunch: "lunch", dinner: "dinner", any: "lunch",
  };

  try {
    const results = await amap.searchRestaurants({
      city,
      mealType: mealTypeMap[mealType] ?? "lunch",
      diningPreference: preference as RestaurantSearchParams["diningPreference"],
      maxResults,
    });

    const filtered = results.filter(r => !CHAIN_BRANDS.has(r.name));
    const items = filtered.map(r => ({
      name: r.name,
      category: "restaurant" as const,
      location: { lat: r.geoLocation?.lat ?? 0, lng: r.geoLocation?.lon ?? 0, address: r.location },
      estimatedDurationMin: Math.round((r.durationHours ?? 1.5) * 60),
      estimatedCost: r.price,
      description: r.description ?? "",
      source: "amap" as const,
      rerankScore: Math.min(1, (r.rating ?? 0) / 10),
    }));

    return {
      success: true,
      data: { scope: "city", items, total: items.length },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `城市餐厅搜索失败:${msg}` };
  }
}

async function executeAttractionScope(city: string, near: string, mealType: string, maxResults: number) {
  if (!near) {
    return { success: false, error: "scope=attraction 时必须提供 near 参数(景点名)" };
  }

  try {
    const coords = await geocodeNear(near, city);
    if (!coords) {
      return { success: false, error: `无法定位景点"${near}"` };
    }

    const keywords = mealType !== "any" ? mealType : "美食";
    const qs = new URLSearchParams({
      key: settings.AMAP_API_KEY,
      keywords,
      types: "050000",
      location: `${coords.lng},${coords.lat}`,
      radius: "1500",
      offset: String(Math.min(maxResults + 5, 25)),
      page: "1",
    });

    const resp = await fetch(`https://restapi.amap.com/v3/place/around?${qs}`, {
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) throw new Error(`高德周边搜索失败 (${resp.status})`);
    const data = await resp.json() as { status: string; pois: Array<{ name: string; address: string; location: string; cost: string; rating: string }>; info?: string };

    if (data.status !== "1" || !data.pois?.length) {
      return { success: true, data: { scope: "attraction", near, items: [], total: 0 } };
    }

    const items = data.pois
      .filter(p => !CHAIN_BRANDS.has(p.name))
      .slice(0, maxResults)
      .map(p => {
        const [lng, lat] = (p.location ?? "0,0").split(",").map(Number);
        return {
          name: p.name,
          category: "restaurant" as const,
          location: { lat, lng, address: p.address ?? "" },
          estimatedDurationMin: 60,
          estimatedCost: parseInt(p.cost) || 60,
          description: p.address ?? "",
          source: "amap" as const,
          rerankScore: Math.min(1, (parseFloat(p.rating) || 0) / 10),
        };
      });

    return {
      success: true,
      data: { scope: "attraction", near, items, total: items.length },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `景点周边餐厅搜索失败:${msg}` };
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
