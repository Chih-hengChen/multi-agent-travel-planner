import type { SourceResolver } from "../../data-sources/source-resolver.js";
import type { RegisteredTool } from "../types.js";
import type { Logger } from "pino";
import { HotelSearchInputSchema } from "../schemas/hotel.js";

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
        keyAttractions: { type: "array", items: { type: "string" }, description: "已选景点名称,用于过滤靠近景点的酒店" },
        geoConstraint: {
          type: "object",
          properties: {
            maxDistanceKm: { type: "number", description: "离 keyAttractions 区域的最大距离(km),默认 5(基于 address 文本匹配,精确 Haversine 待 Hotel schema 补 geoLocation)" },
            preferNear: { type: "string", enum: ["transit", "center"], description: "偏好靠近地铁站/市中心" },
          },
        },
        preferredBrands: { type: "array", items: { type: "string" }, description: "偏好品牌,如:希尔顿、万豪" },
      },
      required: ["city", "check_in", "check_out"],
    },
    metadata: { category: "search", timeout: 30_000 },
    execute: async (input) => {
      const parsed = HotelSearchInputSchema.safeParse({
        city: input.city,
        checkIn: input.check_in,
        checkOut: input.check_out,
        adults: input.adults ?? 1,
        maxPricePerNight: input.max_price_per_night,
        maxStarRating: input.max_star_rating,
        preferredArea: input.preferredArea,
        keyAttractions: input.keyAttractions,
        geoConstraint: input.geoConstraint,
        preferredBrands: input.preferredBrands,
      });

      if (!parsed.success) {
        return { success: false, data: null, error: `参数校验失败:${parsed.error.issues.map(i => i.path.join(".") + ":" + i.message).join("; ")}` };
      }
      const p = parsed.data;

      try {
        let hotels = await resolver.resolveHotels({
          city: p.city,
          checkIn: p.checkIn,
          checkOut: p.checkOut,
          adults: p.adults,
          maxPricePerNight: p.maxPricePerNight,
          maxStarRating: p.maxStarRating,
        });

        if (p.preferredArea) {
          const area = p.preferredArea;
          const areaFiltered = hotels.filter(h => h.address?.includes(area) || h.name?.includes(area));
          if (areaFiltered.length > 0) hotels = areaFiltered;
        }

        if (p.preferredBrands?.length) {
          const brands = p.preferredBrands.map(b => b.toLowerCase());
          const brandMatch = hotels.filter(h => brands.some(b => h.name.toLowerCase().includes(b)));
          if (brandMatch.length > 0) hotels = brandMatch;
        }

        if (p.keyAttractions?.length) {
          const attrFiltered = hotels.filter(h =>
            p.keyAttractions!.some(k => h.address?.includes(k) || h.name?.includes(k)),
          );
          if (attrFiltered.length > 0) hotels = attrFiltered;
        }

        if (p.geoConstraint?.preferNear === "center") {
          hotels.sort((a, b) => a.distanceToCenterKm - b.distanceToCenterKm);
        } else if (p.geoConstraint?.preferNear === "transit") {
          hotels.sort((a, b) => {
            const aNear = /地铁|站|metro|subway/i.test(a.address ?? "") ? 0 : 1;
            const bNear = /地铁|站|metro|subway/i.test(b.address ?? "") ? 0 : 1;
            return aNear - bNear;
          });
        }

        const summary = hotels.length > 0
          ? hotels.slice(0, 5).map(h => `${h.name} ${h.starRating}星 ¥${h.pricePerNight}/晚 评分${h.userRating} ${h.address}`).join("\n")
          : "未找到符合条件的酒店";

        const sources = hotels.slice(0, 3).map(h => ({
          title: `${h.name} ${h.starRating}星`,
          url: "https://www.booking.com/",
          type: "hotel" as const,
        }));

        log?.info({ city: p.city, count: hotels.length, hasGeo: !!p.geoConstraint }, "search_hotels executed");
        return { success: true, data: { hotels, summary }, sources };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, data: null, error: msg };
      }
    },
  };
}
