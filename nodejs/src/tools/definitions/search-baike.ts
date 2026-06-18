import { settings } from "../../config/settings.js";
import type { RegisteredTool } from "../types.js";

export function createSearchBaikeTool(): RegisteredTool {
  return {
    name: "search_baike",
    description: "百科检索:获取目的地城市概况、历史文化、气候、交通、必游景点。用于 searching 阶段建立城市认知。",
    input_schema: {
      type: "object",
      properties: {
        city: { type: "string", description: "城市名" },
      },
      required: ["city"],
    },
    metadata: { category: "search", timeout: 15_000 },
    execute: async (input) => {
      const city = String(input.city ?? "");

      try {
        const resp = await fetch(`${settings.WEBSEARCH_DAEMON_URL}/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: `${city} 百度百科`, engines: ["baidu"] }),
          signal: AbortSignal.timeout(12_000),
        });

        if (!resp.ok) throw new Error(`daemon returned ${resp.status}`);
        const data = await resp.json() as { results?: Array<{ title: string; description: string }> };
        const results = data.results ?? [];

        if (!results.length) {
          return { success: true, data: { summary: "", source: "llm_generated" } };
        }

        const summary = results.slice(0, 3)
          .map(r => r.description ?? "")
          .filter(Boolean)
          .join("\n")
          .slice(0, 2000);

        return { success: true, data: { summary, source: "web_search_baidu" } };
      } catch {
        return { success: true, data: { summary: "", source: "llm_generated" } };
      }
    },
  };
}
