import type { SourceResolver } from "../../data-sources/source-resolver.js";
import type { RegisteredTool } from "../types.js";
import type { Logger } from "pino";

export function createSearchFlightsTool(resolver: SourceResolver, log?: Logger): RegisteredTool {
  return {
    name: "search_flights",
    description: "搜索航班信息。输入出发城市、到达城市和日期，返回可用航班列表（航班号、时间、价格）。",
    input_schema: {
      type: "object",
      properties: {
        origin: { type: "string", description: "出发城市，如：上海" },
        destination: { type: "string", description: "到达城市，如：北京" },
        date: { type: "string", description: "出发日期 YYYY-MM-DD" },
        adults: { type: "number", description: "乘客人数，默认 1" },
        max_price: { type: "number", description: "最高票价限制（元）" },
      },
      required: ["origin", "destination", "date"],
    },
    metadata: { category: "search", timeout: 30_000 },
    execute: async (input) => {
      try {
        const flights = await resolver.resolveFlights({
          origin: String(input.origin ?? ""),
          destination: String(input.destination ?? ""),
          departureDate: String(input.date ?? ""),
          adults: Number(input.adults) || 1,
          maxPrice: input.max_price ? Number(input.max_price) : undefined,
        });

        const summary = flights.length > 0
          ? flights.slice(0, 5).map((f) => `${f.flightNo} ${f.airline} ${f.departureTime}-${f.arrivalTime} ¥${f.price} ${f.cabinClass}`).join("\n")
          : "未找到符合条件的航班";

        const sources = flights.slice(0, 3).map((f) => ({
          title: `${f.flightNo} ${f.departureCity}-${f.arrivalCity}`,
          url: `https://flights.ctrip.com/`,
          type: "flight" as const,
        }));

        log?.info({ origin: input.origin, destination: input.destination, date: input.date, count: flights.length }, "search_flights executed");
        return { success: true, data: { flights, summary }, sources };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, data: null, error: msg };
      }
    },
  };
}
