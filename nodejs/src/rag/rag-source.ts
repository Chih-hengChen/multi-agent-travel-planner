import type { RagSearchParams, RagSearchResult, RagSourceStats, RagDocument } from "./types.js";
import { Embedder } from "./embedder.js";
import { MemoryVectorStore, type IVectorStore } from "./vector-store.js";
import { ChromaVectorStore } from "./chroma-store.js";
import { loadSeedDirectory, convertBaikeToDocs, convertXhsToDocs } from "./corpus-loader.js";
import { settings } from "../config/settings.js";
import { streamChat } from "../api/llm-client.js";
import type { Logger } from "pino";

const SIMILARITY_THRESHOLD = 0.3;

export type RagVariant = "v0" | "v1" | "v2" | "v3" | "v4" | "v5" | "v6";

const expansionCache = new Map<string, string[]>();

const EXPANSION_PROMPT = `你是旅游领域专家。给定用户的旅行问题，生成 3 个语义等价但用词不同的变体，覆盖旅游攻略里可能出现的表达方式。
规则：
- 替换地名别名（如"故宫"→"紫禁城"、"蓉城"→"成都"）
- 替换同义表达（如"怎么玩"→"游览攻略"、"必吃"→"美食推荐"）
- 保持原问题意图不变
- 严格只输出 3 行变体，每行一个，不编号、不解释、不输出原问题

用户问题：`;

async function expandQuery(query: string): Promise<string[]> {
  const cached = expansionCache.get(query);
  if (cached) return cached;

  try {
    const result = await streamChat(
      [{ role: "user", content: EXPANSION_PROMPT + query }],
      undefined,
      undefined,
      undefined,
      undefined,
    );
    const text = result.assistantContent
      .filter(b => b.type === "text")
      .map(b => (b as { type: "text"; text: string }).text)
      .join("");
    const expansions = text
      .split("\n")
      .map(l => l.replace(/^[\d\.\-\s]+/, "").trim())
      .filter(l => l.length > 1 && l !== query);
    const out = [...new Set([query, ...expansions])];
    expansionCache.set(query, out);
    return out;
  } catch (e) {
    console.error("[rag] expandQuery LLM error:", (e as Error).message);
    return [query];
  }
}

function tokenizeZh(text: string): string[] {
  const raw = text.toLowerCase();
  const chars = raw.replace(/[\s,，。、！？:：;；\-—()（）""''「」【】]+/g, "").split("");
  const bigrams: string[] = [];
  for (let i = 0; i < chars.length - 1; i++) bigrams.push(chars[i] + chars[i + 1]);
  return [...new Set([...chars, ...bigrams])].filter((t) => t.length > 0);
}

function bm25Score(
  queryTokens: string[],
  docContent: string,
  docLen: number,
  avgDocLen: number,
  df: Map<string, number>,
  totalDocs: number,
): number {
  const k1 = 1.5;
  const b = 0.75;
  const lowerContent = docContent.toLowerCase();
  const tf: Map<string, number> = new Map();
  for (const t of queryTokens) {
    let count = 0;
    let idx = lowerContent.indexOf(t);
    while (idx >= 0) { count++; idx = lowerContent.indexOf(t, idx + 1); }
    if (count > 0) tf.set(t, count);
  }
  let score = 0;
  for (const [t, f] of tf) {
    const n = df.get(t) ?? 0;
    const idf = Math.log(1 + (totalDocs - n + 0.5) / (n + 0.5));
    const denom = f + k1 * (1 - b + b * (docLen / avgDocLen));
    score += (idf * (f * (k1 + 1))) / denom;
  }
  return score;
}

export class RagSource {
  private embedder = new Embedder();
  private store: IVectorStore;
  private initialized = false;
  private log?: Logger;
  private readonly variant: RagVariant;
  private readonly corpusDir?: string;

  constructor(log?: Logger, variant: RagVariant = "v0", corpusDir?: string) {
    this.log = log;
    this.variant = variant;
    this.corpusDir = corpusDir;
    const persistKey = corpusDir ? `travel_guides_${variant}` : undefined;
    if (settings.RAG_CHROMA_URL) {
      this.store = new ChromaVectorStore(settings.RAG_CHROMA_URL);
    } else if (persistKey) {
      this.store = new MemoryVectorStore(persistKey);
    } else {
      this.store = new MemoryVectorStore("travel_guides");
    }
  }

  async ensureInit(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    if (!settings.RAG_ENABLED) { this.log?.info("rag: disabled"); return; }

    const count = await this.store.count();
    this.log?.info({ storeType: settings.RAG_CHROMA_URL ? "chroma" : "memory", docs: count, variant: this.variant }, "rag: ready");

    if (count === 0) {
      const seeds = loadSeedDirectory(this.corpusDir);
      if (seeds.length > 0) {
        this.log?.info({ count: seeds.length, corpusDir: this.corpusDir ?? "data/guides" }, "rag: loading seed JSONL");
        await this.addDocuments(seeds);
      }
    }
  }

  async addDocuments(docs: RagDocument[]): Promise<void> {
    const texts = docs.map((d) => d.content);
    const embeddings = await this.embedder.embedBatch(texts);
    await this.store.add(docs, embeddings);
  }

  async search(params: RagSearchParams): Promise<RagSearchResult[]> {
    await this.ensureInit();
    if (!settings.RAG_ENABLED || !this.store) return [];

    const queryVector = await this.embedder.embed(params.query);
    const hasVector = queryVector.length > 0;

    const topK = (params.maxResults ?? 10) * 2;
    let results: RagSearchResult[] = [];

    if (hasVector) {
      results = await this.store.search(queryVector, topK, {
        city: params.city,
        category: params.category && params.category !== "all" ? params.category : undefined,
      });
    }

    const keywordFallback = (): RagSearchResult[] => this.bm25Search(
      params.query,
      params.city,
      params.category && params.category !== "all" ? params.category : undefined,
      params.maxResults ?? 5,
    );

    const filtered = results.filter((r) => r.score >= SIMILARITY_THRESHOLD);

    if (!hasVector) return keywordFallback();

    if (this.variant === "v0" && filtered.length === 0) {
      return keywordFallback();
    }

    if (this.variant === "v5") {
      const expansions = await expandQuery(params.query);
      const perQueryResults = await Promise.all(
        expansions.map(q => this.embedder.embed(q).then(v => this.store.search(v, topK, {
          city: params.city,
          category: params.category && params.category !== "all" ? params.category : undefined,
        }))),
      );
      const bestById = new Map<string, RagSearchResult>();
      const merge = (r: RagSearchResult) => {
        const prev = bestById.get(r.document.id);
        if (!prev || r.score > prev.score) bestById.set(r.document.id, r);
      };
      for (const r of results) merge(r);
      for (const list of perQueryResults) for (const r of list) merge(r);
      const merged = [...bestById.values()]
        .filter(r => r.score >= SIMILARITY_THRESHOLD)
        .sort((a, b) => b.score - a.score);
      if (merged.length === 0) return keywordFallback();
      return merged.slice(0, params.maxResults ?? 5);
    }

    if (this.variant === "v6") {
      const expansions = await expandQuery(params.query);
      const maxResults = params.maxResults ?? 5;
      const city = params.city;
      const category = params.category && params.category !== "all" ? params.category : undefined;
      const tokenSet = new Set<string>();
      for (const q of expansions) for (const t of tokenizeZh(q)) tokenSet.add(t);
      const mergedTokens = [...tokenSet];
      return this.bm25SearchWithTokens(mergedTokens, city, category, maxResults);
    }

    if (this.variant === "v3") {
      const store = this.store as any;
      const entries: Array<{ doc: RagDocument; embedding: number[] }> = store.entries ?? store._entries ?? [];
      const matched = new Map<string, RagSearchResult>();
      for (const r of results) matched.set(r.document.id, r);
      for (const e of entries) {
        if (params.city && e.doc.metadata.city !== params.city) continue;
        if (!matched.has(e.doc.id)) {
          matched.set(e.doc.id, { document: e.doc, score: 0 });
        }
      }
      const all = [...matched.values()];
      const totalDocs = all.length;
      const avgDocLen = all.reduce((s, r) => s + r.document.content.length, 0) / Math.max(1, totalDocs);
      const queryTokens = tokenizeZh(params.query);
      const df = new Map<string, number>();
      for (const t of queryTokens) {
        let n = 0;
        for (const r of all) if (r.document.content.toLowerCase().includes(t)) n++;
        df.set(t, n);
      }
      const bmRaw = all.map(r => bm25Score(queryTokens, r.document.content, r.document.content.length, avgDocLen, df, totalDocs));
      const vecRaw = all.map(r => r.score);
      const minMax = (xs: number[]): number[] => {
        const lo = Math.min(...xs);
        const hi = Math.max(...xs);
        const span = hi - lo;
        return span === 0 ? xs.map(() => 0.5) : xs.map(x => (x - lo) / span);
      };
      const vecNorm = minMax(vecRaw);
      const bmNorm = minMax(bmRaw);
      const maxVec = Math.max(...vecRaw);
      if (maxVec < SIMILARITY_THRESHOLD) {
        return all.map((r, i) => ({ ...r, score: bmNorm[i] }))
          .sort((a, b) => b.score - a.score)
          .slice(0, params.maxResults ?? 5);
      }
      const alpha = Math.max(0.05, Math.min(0.6, maxVec * 2));
      const fused = all.map((r, i) => ({ ...r, score: alpha * vecNorm[i] + (1 - alpha) * bmNorm[i] }));
      return fused.sort((a, b) => b.score - a.score).slice(0, params.maxResults ?? 5);
    }

    if (this.variant === "v4") {
      if (filtered.length === 0) return keywordFallback();
      const lambda = 0.7;
      const candidates = [...filtered].sort((a, b) => b.score - a.score);
      const selected: RagSearchResult[] = [];
      const selectedTitleTokens: Set<string>[] = [];
      while (selected.length < (params.maxResults ?? 5) && candidates.length > 0) {
        let best: RagSearchResult | null = null;
        let bestIdx = -1;
        let bestScore = -Infinity;
        for (let i = 0; i < candidates.length; i++) {
          const c = candidates[i];
          const rel = lambda * c.score;
          const cTokens = new Set(tokenizeZh(c.document.metadata.title + " " + c.document.content.slice(0, 100)));
          let maxOverlap = 0;
          for (const sTokens of selectedTitleTokens) {
            let overlap = 0;
            for (const t of cTokens) if (sTokens.has(t)) overlap++;
            const norm = Math.max(1, Math.min(cTokens.size, sTokens.size));
            const sim = overlap / norm;
            if (sim > maxOverlap) maxOverlap = sim;
          }
          const mmr = rel - (1 - lambda) * maxOverlap;
          if (mmr > bestScore) { bestScore = mmr; best = c; bestIdx = i; }
        }
        if (!best || bestIdx < 0) break;
        selected.push(best);
        selectedTitleTokens.push(new Set(tokenizeZh(best.document.metadata.title + " " + best.document.content.slice(0, 100))));
        candidates.splice(bestIdx, 1);
      }
      return selected;
    }

    return filtered
      .sort((a, b) => {
        const aKw = params.query.split(" ").some((kw) => a.document.content.includes(kw)) ? 0.1 : 0;
        const bKw = params.query.split(" ").some((kw) => b.document.content.includes(kw)) ? 0.1 : 0;
        return (b.score + bKw) - (a.score + aKw);
      })
      .slice(0, params.maxResults ?? 5);
  }

  async formatForLlm(params: RagSearchParams): Promise<string> {
    const start = Date.now();
    const results = await this.search(params);
    const latency = Date.now() - start;

    this.log?.info({
      city: params.city, query: params.query?.slice(0, 60),
      hits: results.length, topScore: results[0]?.score ?? 0, latency,
    }, "rag: search");

    if (results.length === 0) return "";

    const lines = results.map((r) => {
      const d = r.document;
      return "【" + d.metadata.title + "】(" + d.metadata.source + ", " + d.metadata.category + ")\n" + d.content.slice(0, 300);
    });

    return "以下是从旅行攻略库中找到的相关信息：\n\n" + lines.join("\n\n");
  }

  async getStats(): Promise<RagSourceStats> {
    const totalDocs = await this.store.count();
    return { totalDocs, byCity: {}, byCategory: {}, bySource: {} };
  }

  private bm25Search(
    query: string,
    city: string | undefined,
    category: string | undefined,
    maxResults: number,
  ): RagSearchResult[] {
    return this.bm25SearchWithTokens(tokenizeZh(query), city, category, maxResults);
  }

  private bm25SearchWithTokens(
    queryTokens: string[],
    city: string | undefined,
    category: string | undefined,
    maxResults: number,
  ): RagSearchResult[] {
    const store = this.store as any;
    const entries: Array<{ doc: RagDocument; embedding: number[] }> = store.entries ?? store._entries;
    if (!entries?.length) return [];
    const filtered = entries.filter((e) => {
      if (city) {
        const dc = e.doc.metadata.city;
        if (dc !== city && !(dc && dc.startsWith(city))) return false;
      }
      if (category && e.doc.metadata.category !== category) return false;
      return true;
    });
    if (filtered.length === 0) return [];

    const totalDocs = filtered.length;
    const avgDocLen = filtered.reduce((s, e) => s + e.doc.content.length, 0) / totalDocs;
    const df = new Map<string, number>();
    for (const t of queryTokens) {
      let n = 0;
      for (const e of filtered) if (e.doc.content.toLowerCase().includes(t)) n++;
      df.set(t, n);
    }
    return filtered
      .map((e) => ({
        document: e.doc,
        score: bm25Score(queryTokens, e.doc.content, e.doc.content.length, avgDocLen, df, totalDocs),
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
  }
}
