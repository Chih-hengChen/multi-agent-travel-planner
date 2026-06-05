import { settings } from "../../config/settings.js";
import type { RegisteredTool, ToolResult, ToolSource } from "../types.js";
import type { Logger } from "pino";

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

interface XhsNoteDetail {
  success: boolean;
  note: { title: string; desc: string; image_list: string[]; tags: string[] };
  error?: string;
}

export function createSearchXhsTool(log?: Logger): RegisteredTool {
  return {
    name: "search_xhs_notes",
    description: "搜索小红书旅游攻略笔记。当用户询问目的地旅游推荐、当地体验、真实评价、避坑指南等内容时优先使用此工具，获取真实的用户分享内容。",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词，如：'北京旅游攻略'、'故宫一日游'、'环球影城避坑'" },
        limit: { type: "number", description: "返回笔记数量，默认 5，最大 10", default: 5 },
      },
      required: ["query"],
    },
    metadata: { category: "search", timeout: 20_000 },
    execute: async (input) => {
      const query = String(input.query ?? "");
      const limit = Math.min(Number(input.limit) || 5, 10);

      try {
        const result = await searchViaXhsService(query, limit);
        if (result) return result;
      } catch {
        log?.info("XHS service unavailable, falling back to web search");
      }

      return searchViaWebFallback(query, limit);
    },
  };

  async function searchViaXhsService(query: string, limit: number): Promise<ToolResult | null> {
    const baseUrl = settings.XHS_SERVICE_URL;
    if (!baseUrl) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    try {
      const resp = await fetch(`${baseUrl}/xhs/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, limit }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!resp.ok) return null;

      const data = (await resp.json()) as XhsSearchResponse;
      if (!data.success || !data.notes?.length) {
        return { success: true, data: { summary: "小红书未找到相关笔记", notes: [] }, sources: [] };
      }

      const notesWithContent = await enrichTopNotes(data.notes.slice(0, 3), baseUrl);

      const allNotes = data.notes.map((n) => {
        const enriched = notesWithContent.get(n.id);
        return enriched ?? n;
      });

      const summary = allNotes
        .map((n) => `【${n.title}】by ${n.nickname} ❤️${n.liked_count} ⭐${n.collected_count}\n${n.desc?.slice(0, 200) ?? ""}`)
        .join("\n\n");

      const sources: ToolSource[] = data.notes.map((n) => ({
        title: n.title,
        url: n.url,
        type: "xhs" as const,
      }));

      log?.info({ query, noteCount: data.notes.length }, "search_xhs via service");
      return { success: true, data: { summary, notes: allNotes }, sources };
    } finally {
      clearTimeout(timer);
    }
  }

  async function enrichTopNotes(
    notes: XhsNote[],
    baseUrl: string,
  ): Promise<Map<string, XhsNote>> {
    const result = new Map<string, XhsNote>();
    const enriched = await Promise.allSettled(
      notes.map(async (note) => {
        try {
          const resp = await fetch(`${baseUrl}/xhs/note`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: note.url }),
            signal: AbortSignal.timeout(10_000),
          });
          if (!resp.ok) return null;
          const detail = (await resp.json()) as XhsNoteDetail;
          if (detail.success && detail.note) {
            return { ...note, desc: detail.note.desc ?? note.desc, tags: detail.note.tags ?? note.tags };
          }
        } catch { /* ignore */ }
        return null;
      }),
    );

    enriched.forEach((r, i) => {
      if (r.status === "fulfilled" && r.value) {
        result.set(notes[i].id, r.value);
      }
    });
    return result;
  }

  async function searchViaWebFallback(query: string, _limit: number): Promise<ToolResult> {
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

      if (results.length === 0) {
        return { success: true, data: { summary: "未找到相关小红书笔记", notes: [] }, sources: [] };
      }

      const summary = results
        .slice(0, 5)
        .map((r, i) => `${i + 1}. ${r.title}\n${r.description ?? ""}`)
        .join("\n\n");

      const sources: ToolSource[] = results
        .filter((r) => r.url?.includes("xiaohongshu.com"))
        .slice(0, 5)
        .map((r) => ({ title: r.title, url: r.url, type: "xhs" as const }));

      return { success: true, data: { summary, notes: [], fallback: true }, sources };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, data: null, error: `XHS search failed: ${msg}` };
    }
  }
}
