import type { SourceResolver } from "../../data-sources/source-resolver.js";
import type { RegisteredTool } from "../types.js";
import type { Logger } from "pino";

export function createSearchHotelsTool(resolver: SourceResolver, log?: Logger): RegisteredTool {
  return {
    name: "search_hotels",
    description: "搜索酒店。输入城市、入住/退房日期，返回酒店列表（名称、星级、价格、评分）。",
    input_schema: {
      type: "object",
      properties: {
        city: { type: "string", description: "城市名称，如：北京" },
        check_in: { type: "string", description: "入住日期 YYYY-MM-DD" },
        check_out: { type: "string", description: "退房日期 YYYY-MM-DD" },
        adults: { type: "number", description: "入住人数，默认 1" },
        max_price_per_night: { type: "number", description: "每晚最高预算（元）" },
        max_star_rating: { type: "number", description: "最高星级限制" },
      },
      required: ["city", "check_in", "check_out"],
    },
    metadata: { category: "search", timeout: 30_000 },
    execute: async (input) => {
      try {
        const hotels = await resolver.resolveHotels({
          city: String(input.city ?? ""),
          checkIn: String(input.check_in ?? ""),
          checkOut: String(input.check_out ?? ""),
          adults: Number(input.adults) || 1,
          maxPricePerNight: input.max_price_per_night ? Number(input.max_price_per_night) : undefined,
          maxStarRating: input.max_star_rating ? Number(input.max_star_rating) : undefined,
        });

        const summary = hotels.length > 0
          ? hotels.slice(0, 5).map((h) => `${h.name} ${h.starRating}星 ¥${h.pricePerNight}/晚 评分${h.userRating} ${h.address}`).join("\n")
          : "未找到符合条件的酒店";

        const sources = hotels.slice(0, 3).map((h) => ({
          title: `${h.name} ${h.starRating}星`,
          url: `https://www.booking.com/`,
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
