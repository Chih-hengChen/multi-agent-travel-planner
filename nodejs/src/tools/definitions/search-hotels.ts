import type { SourceResolver } from "../../data-sources/source-resolver.js";
import type { RegisteredTool } from "../types.js";
import type { Logger } from "pino";

export function createSearchHotelsTool(resolver: SourceResolver, log?: Logger): RegisteredTool {
  return {
    name: "search_hotels",
    description: "搜索酒店。输入城市、入住/退房日期，返回酒店列表（名称、星级、价格、评分）。可选参数:区域偏好、景点约束、品牌过滤。",
    input_schema: {
      type: "object",
      properties: {
        city: { type: "string", description: "城市名称" },
        check_in: { type: "string", description: "入住日期 YYYY-MM-DD" },
        check_out: { type: "string", description: "退房日期 YYYY-MM-DD" },
        adults: { type: "number", description: "入住人数,默认 1" },
        max_price_per_night: { type: "number", description: "每晚最高预算(元)" },
        max_star_rating: { type: "number", description: "最高星级限制" },
        preferredArea: { type: "string", description: "偏好区域,如:故宫附近、朝阳区" },
        keyAttractions: { type: "array", items: { type: "string" }, description: "已选景点名称,用于计算最佳住宿位置" },
        geoConstraint: {
          type: "object",
          properties: {
            maxDistanceKm: { type: "number", description: "离 keyAttractions 区域的最大距离(km),默认 5" },
            preferNear: { type: "string", enum: ["transit", "center"], description: "偏好靠近地铁站/市中心" },
          },
        },
        preferredBrands: { type: "array", items: { type: "string" }, description: "偏好品牌,如:希尔顿、万豪" },
      },
      required: ["city", "check_in", "check_out"],
    },
    metadata: { category: "search", timeout: 30_000 },
    execute: async (input) => {
      try {
        let hotels = await resolver.resolveHotels({
          city: String(input.city ?? ""),
          checkIn: String(input.check_in ?? ""),
          checkOut: String(input.check_out ?? ""),
          adults: Number(input.adults) || 1,
          maxPricePerNight: input.max_price_per_night ? Number(input.max_price_per_night) : undefined,
          maxStarRating: input.max_star_rating ? Number(input.max_star_rating) : undefined,
        });

        if (input.preferredArea) {
          const area = String(input.preferredArea);
          hotels = hotels.filter(h => h.address?.includes(area) || h.name?.includes(area));
        }

        if (input.preferredBrands) {
          const brands = (input.preferredBrands as string[]).map(b => b.toLowerCase());
          hotels = hotels.filter(h => brands.some(b => h.name.toLowerCase().includes(b)));
        }

        if (input.geoConstraint?.preferNear === "center") {
          hotels.sort((a, b) => a.distanceToCenterKm - b.distanceToCenterKm);
        }

        const summary = hotels.length > 0
          ? hotels.slice(0, 5).map(h => `${h.name} ${h.starRating}星 ¥${h.pricePerNight}/晚 评分${h.userRating} ${h.address}`).join("\n")
          : "未找到符合条件的酒店";

        const sources = hotels.slice(0, 3).map(h => ({
          title: `${h.name} ${h.starRating}星`,
          url: "https://www.booking.com/",
          type: "hotel" as const,
        }));

        log?.info({ city: input.city, count: hotels.length }, "search_hotels executed");
        return { success: true, data: { hotels, summary }, sources };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, data: null, error: msg };
      }
    },
  };
}
