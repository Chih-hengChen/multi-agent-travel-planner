import { settings } from "../../config/settings.js";
import type { RegisteredTool, ToolResult, ToolSource } from "../types.js";

interface XhsNote {
  id: string;
  title: string;
  desc: string;
  nickname: string;
  liked_count: number;
  collected_count: number;
  tags: string[];
  url: string;
  upload_time: string;
}

interface XhsSearchResponse {
  success: boolean;
  notes: XhsNote[];
  error?: string;
}

export function createSearchXhsTool(): RegisteredTool {
  return {
    name: "search_xhs",
    description: "小红书笔记搜索。默认抓 30 篇，不够再抓 30（渐进式）。提供真实游客评价、避坑提示、小众玩法。",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词，如：'北京旅游攻略'、'故宫一日游'" },
        limit: { type: "number", description: "期望返回数，默认 30", default: 30 },
        extendIfFew: { type: "number", description: "结果不足 limit/半时追加抓取条数，默认 30", default: 30 },
      },
      required: ["query"],
    },
    metadata: { category: "search", timeout: 30_000 },
    execute: async (input) => {
      const query = String(input.query ?? "");
      const limit = Number(input.limit) || 30;
      const extendIfFew = Number(input.extendIfFew) || 30;

      let notes = await callXhsService(query, limit);

      if (notes.length < limit / 2) {
        const expanded = expandQuery(query);
        const more = await Promise.all(
          expanded.slice(1, 3).map(q => callXhsService(q, Math.ceil(extendIfFew / 2)))
        );
        notes = dedupeByNoteId([...notes, ...more.flat()]);
      }

      if (!notes.length) {
        return await webSearchFallback(query, limit);
      }

      const ranked = rerankXhs(notes);
      const top = ranked.slice(0, 10);

      const summary = top
        .map(n => `【${n.title}】by ${n.nickname} ❤️${n.liked_count} ⭐${n.collected_count}\n${n.desc?.slice(0, 200) ?? ""}`)
        .join("\n\n");

      const sources: ToolSource[] = top.map(n => ({
        title: n.title,
        url: n.url,
        type: "xhs" as const,
      }));

      return {
        success: true,
        data: { summary, notes, top, total: notes.length },
        sources,
      };
    },
  };

  async function callXhsService(query: string, limit: number): Promise<XhsNote[]> {
    const baseUrl = settings.XHS_SERVICE_URL;
    if (!baseUrl) return [];

    try {
      const resp = await fetch(`${baseUrl}/xhs/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, limit }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) return [];
      const data = (await resp.json()) as XhsSearchResponse;
      return data.success ? (data.notes ?? []) : [];
    } catch {
      return [];
    }
  }

  function expandQuery(q: string): string[] {
    const expansions: Record<string, string[]> = {
      "美食": ["美食", "必吃", "推荐餐厅", "吃货"],
      "景点": ["景点", "必去", "打卡", "游玩"],
      "攻略": ["攻略", "旅游", "旅行", "自由行"],
    };

    for (const [key, exps] of Object.entries(expansions)) {
      if (q.includes(key)) return [q, ...exps];
    }
    return [q, `${q}旅游`, `${q}攻略`, `${q}推荐`];
  }

  function dedupeByNoteId(notes: XhsNote[]): XhsNote[] {
    const seen = new Set<string>();
    return notes.filter(n => {
      if (seen.has(n.id)) return false;
      seen.add(n.id);
      return true;
    });
  }

  function rerankXhs(notes: XhsNote[]): XhsNote[] {
    return notes.sort((a, b) => {
      const aScore = Math.log((b.liked_count || 0) + 1);
      const bScore = Math.log((a.liked_count || 0) + 1);
      return aScore - bScore;
    });
  }

  async function webSearchFallback(query: string, limit: number): Promise<ToolResult> {
    const daemonUrl = settings.WEBSEARCH_DAEMON_URL;
    const searchQuery = `site:xiaohongshu.com ${query}`;

    try {
      const resp = await fetch(`${daemonUrl}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: searchQuery, engines: ["baidu"] }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!resp.ok) throw new Error(`daemon returned ${resp.status}`);
      const data = await resp.json() as { results?: Array<{ title: string; url: string; description: string }> };
      const results = data.results ?? [];

      if (!results.length) {
        return { success: true, data: { summary: "未找到相关小红书笔记", notes: [], top: [], total: 0 }, sources: [] };
      }

      const summary = results.slice(0, limit > 10 ? 10 : 5)
        .map((r, i) => `${i + 1}. ${r.title}\n${r.description ?? ""}`)
        .join("\n\n");

      const sources: ToolSource[] = results
        .filter(r => r.url?.includes("xiaohongshu.com"))
        .slice(0, 5)
        .map(r => ({ title: r.title, url: r.url, type: "xhs" as const }));

      return { success: true, data: { summary, notes: [], top: [], total: 0, fallback: true }, sources };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, data: null, error: `XHS search failed: ${msg}` };
    }
  }
}
