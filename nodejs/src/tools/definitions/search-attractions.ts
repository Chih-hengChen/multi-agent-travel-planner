import type { SourceResolver } from "../../data-sources/source-resolver.js";
import type { RegisteredTool } from "../types.js";
import type { Logger } from "pino";

export function createSearchAttractionsTool(resolver: SourceResolver, log?: Logger): RegisteredTool {
  return {
    name: "search_attractions",
    description: "搜索景点和活动。输入城市名称和可选的兴趣标签，返回景点列表（名称、类别、评分、票价）。",
    input_schema: {
      type: "object",
      properties: {
        city: { type: "string", description: "城市名称，如：北京" },
        interests: {
          type: "array",
          items: { type: "string" },
          description: "兴趣标签，如：历史、美食、购物、自然风光、博物馆",
        },
        max_results: { type: "number", description: "最多返回结果数，默认 10" },
      },
      required: ["city"],
    },
    metadata: { category: "search", timeout: 30_000 },
    execute: async (input) => {
      try {
        const activities = await resolver.resolveAttractions({
          city: String(input.city ?? ""),
          interests: Array.isArray(input.interests) ? input.interests.map(String) : undefined,
          maxResults: Number(input.max_results) || 10,
        });

        const summary = activities.length > 0
          ? activities.slice(0, 8).map((a) =>
              `${a.name} [${a.category}] 评分${a.rating} ¥${a.price} ${a.description}`
            ).join("\n")
          : "未找到符合条件的景点";

        const sources = activities.slice(0, 5).map((a) => ({
          title: a.name,
          url: `https://www.amap.com/search?query=${encodeURIComponent(a.name)}`,
          type: "attraction" as const,
        }));

        log?.info({ city: input.city, count: activities.length }, "search_attractions executed");
        return { success: true, data: { activities, summary }, sources };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, data: null, error: msg };
      }
    },
  };
}
