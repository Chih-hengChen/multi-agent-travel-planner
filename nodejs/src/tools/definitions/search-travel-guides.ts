import { RagSource } from "../../rag/rag-source.js";
import type { RegisteredTool } from "../types.js";

export function createSearchTravelGuidesTool(): RegisteredTool {
  let ragSource: RagSource | null = null;

  async function getRagSource(): Promise<RagSource> {
    if (!ragSource) ragSource = new RagSource();
    return ragSource;
  }

  return {
    name: "search_travel_guides",
    description: "RAG 旅行攻略检索。从本地攻略语料库搜索景点攻略、美食推荐、行程路线、交通贴士。",
    input_schema: {
      type: "object",
      properties: {
        city:       { type: "string", description: "目标城市" },
        query:      { type: "string", description: "自然语言查询,如:故宫一日游攻略" },
        category:   { type: "string", enum: ["attraction", "food", "itinerary", "tips", "all"], description: "类别过滤,默认 all" },
        maxResults: { type: "number", description: "最多返回段落数,默认 5" },
      },
      required: ["city", "query"],
    },
    metadata: { category: "search", timeout: 10_000 },
    execute: async (input) => {
      try {
        const rag = await getRagSource();
        const text = await rag.formatForLlm({
          city: String(input.city),
          query: String(input.query),
          category: String(input.category ?? "all"),
          maxResults: Number(input.maxResults) || 5,
        });
        if (text) {
          return { success: true, data: { guides: text } };
        }
      } catch { /* L1 keywork fallback */ }
      return { success: true, data: { guides: "攻略库中未找到相关信息。" } };
    },
  };
}
