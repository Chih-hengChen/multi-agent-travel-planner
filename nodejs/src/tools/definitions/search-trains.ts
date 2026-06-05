import type { SourceResolver } from "../../data-sources/source-resolver.js";
import type { RegisteredTool } from "../types.js";
import type { Logger } from "pino";

export function createSearchTrainsTool(resolver: SourceResolver, log?: Logger): RegisteredTool {
  return {
    name: "search_trains",
    description: "搜索火车/高铁车次。输入出发城市、到达城市和日期，返回可用车次列表（车次号、时间、票价）。",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "出发城市，如：武汉" },
        to: { type: "string", description: "到达城市，如：北京" },
        date: { type: "string", description: "出发日期 YYYY-MM-DD" },
      },
      required: ["from", "to", "date"],
    },
    metadata: { category: "search", timeout: 30_000 },
    execute: async (input) => {
      try {
        const trains = await resolver.resolveTrains({
          from: String(input.from ?? ""),
          to: String(input.to ?? ""),
          date: String(input.date ?? ""),
        });

        const summary = trains.length > 0
          ? trains.slice(0, 5).map((t) => `${t.trainNo} ${t.trainType} ${t.departureTime}-${t.arrivalTime} ¥${t.price} ${t.seatType}`).join("\n")
          : "未找到符合条件的车次";

        const sources = trains.slice(0, 3).map((t) => ({
          title: `${t.trainNo} ${t.departureCity}-${t.arrivalCity}`,
          url: `https://www.12306.cn/index/`,
          type: "train" as const,
        }));

        log?.info({ from: input.from, to: input.to, date: input.date, count: trains.length }, "search_trains executed");
        return { success: true, data: { trains, summary }, sources };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, data: null, error: msg };
      }
    },
  };
}
