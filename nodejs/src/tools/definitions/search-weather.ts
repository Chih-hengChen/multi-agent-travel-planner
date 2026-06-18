import { AmapWeatherSource } from "../../data-sources/amap-weather-source.js";
import type { RegisteredTool } from "../types.js";

export function createSearchWeatherTool(): RegisteredTool {
  return {
    name: "search_weather",
    description: "查询目的地实时天气和未来天气预报。用于行程安排、穿衣建议、户外活动决策。",
    input_schema: {
      type: "object",
      properties: {
        city: { type: "string", description: "城市名" },
      },
      required: ["city"],
    },
    metadata: { category: "search", timeout: 10_000 },
    execute: async (input) => {
      const city = String(input.city ?? "");

      try {
        const weatherSource = new AmapWeatherSource();
        const result = await weatherSource.getFullWeather(city);
        if (!result) {
          return { success: true, data: { summary: "天气数据暂不可用" } };
        }

        const lines: string[] = [];
        if (result.live) {
          lines.push(`【当前天气】${result.live.city} ${result.live.weather} ${result.live.temperature}℃ ${result.live.winddirection}风 ${result.live.windpower}级`);
        }
        if (result.forecast?.casts?.length) {
          lines.push("【未来天气预报】");
          for (const c of result.forecast.casts) {
            lines.push(`${c.date} 白天:${c.dayweather} ${c.daytemp}℃ 夜间:${c.nightweather} ${c.nighttemp}℃ ${c.daywind}风${c.daypower}级`);
          }
        }

        return {
          success: true,
          data: {
            live: result.live,
            forecast: result.forecast,
            summary: lines.join("\n"),
          },
        };
      } catch {
        return { success: true, data: { summary: "天气数据暂不可用" } };
      }
    },
  };
}
