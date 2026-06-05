import { settings } from "../../config/settings.js";
import type { RegisteredTool, ToolSource } from "../types.js";
import type { Logger } from "pino";

export function createSearchWebTool(_webSearch?: unknown, log?: Logger): RegisteredTool {
  return {
    name: "search_web",
    description: "通用网络搜索工具。当需要查询实时信息（如票价、天气、景点开放时间、新闻等）时使用。返回搜索结果摘要。",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
        kind: { type: "string", description: "搜索类型：trains/flights/hotels/attractions/general", default: "general" },
      },
      required: ["query"],
    },
    metadata: { category: "search", timeout: 15_000 },
    execute: async (input) => {
      try {
        const query = String(input.query ?? "");

        const resp = await fetch(`${settings.WEBSEARCH_DAEMON_URL}/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query, engines: ["baidu", "bing"] }),
          signal: AbortSignal.timeout(12_000),
        });

        if (!resp.ok) throw new Error(`daemon returned ${resp.status}`);

        const data = await resp.json() as { results?: Array<{ title: string; url: string; description: string }> };
        const results = data.results ?? [];

        if (results.length === 0) {
          return { success: true, data: { summary: "未找到相关结果", results: [] }, sources: [] };
        }

        const topResults = results.slice(0, 5);
        const summary = topResults
          .map((r, i) => `${i + 1}. ${r.title}: ${r.description ?? ""}`)
          .join("\n");

        const sources: ToolSource[] = topResults
          .filter((r) => r.url)
          .map((r) => ({ title: r.title, url: r.url, type: "web" as const }));

        log?.info({ query, resultCount: topResults.length }, "search_web executed");
        return { success: true, data: { summary, resultCount: topResults.length }, sources };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, data: null, error: msg };
      }
    },
  };
}
