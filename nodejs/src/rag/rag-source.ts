import type { RagSearchParams, RagSearchResult, RagSourceStats, RagDocument } from "./types.js";
import { Embedder } from "./embedder.js";
import { MemoryVectorStore, type IVectorStore } from "./vector-store.js";
import { ChromaVectorStore } from "./chroma-store.js";
import { loadSeedDirectory, convertBaikeToDocs, convertXhsToDocs } from "./corpus-loader.js";
import { settings } from "../config/settings.js";
import type { Logger } from "pino";

const SIMILARITY_THRESHOLD = 0.3;

export class RagSource {
  private embedder = new Embedder();
  private store: IVectorStore = settings.RAG_CHROMA_URL ? new ChromaVectorStore(settings.RAG_CHROMA_URL) : new MemoryVectorStore("travel_guides");
  private initialized = false;
  private log?: Logger;

  constructor(log?: Logger) { this.log = log; }

  async ensureInit(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    if (!settings.RAG_ENABLED) { this.log?.info("rag: disabled"); return; }

    const count = await this.store.count();
    this.log?.info({ storeType: settings.RAG_CHROMA_URL ? "chroma" : "memory", docs: count }, "rag: ready");

    if (count === 0) {
      const seeds = loadSeedDirectory();
      if (seeds.length > 0) {
        this.log?.info({ count: seeds.length }, "rag: loading seed JSONL");
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

    // Keyword fallback: character-level token matching for Chinese
    if (!hasVector || results.every((r) => r.score < SIMILARITY_THRESHOLD)) {
      const store = this.store as any;
      const entries: Array<{ doc: RagDocument; embedding: number[] }> = store.entries ?? store._entries;
      if (entries?.length) {
        const city = params.city;
        const category = params.category && params.category !== "all" ? params.category : undefined;
        // Tokenize: individual chars + bigrams + whole words
        const raw = params.query.toLowerCase();
        const chars = raw.replace(/[\s,，。、！？:：;；\-—()（）""''「」【】]+/g, "").split("");
        const bigrams: string[] = [];
        for (let i = 0; i < chars.length - 1; i++) bigrams.push(chars[i] + chars[i + 1]);
        const tokens = [...new Set([...chars, ...bigrams])].filter((t) => t.length > 0);

        return entries
          .filter((e) => {
            if (city && e.doc.metadata.city !== city) return false;
            if (category && e.doc.metadata.category !== category) return false;
            return true;
          })
          .map((e) => {
            const content = e.doc.content.toLowerCase();
            const title = e.doc.metadata.title.toLowerCase();
            let score = 0;
            for (const t of tokens) {
              if (content.includes(t)) score += 1;
              if (title.includes(t)) score += 2;
            }
            return { document: e.doc, score: tokens.length > 0 ? score / tokens.length : 0 };
          })
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, params.maxResults ?? 5);
      }
    }

    const scored = results
      .filter((r) => r.score >= SIMILARITY_THRESHOLD)
      .sort((a, b) => {
        const aKw = params.query.split(" ").some((kw) => a.document.content.includes(kw)) ? 0.1 : 0;
        const bKw = params.query.split(" ").some((kw) => b.document.content.includes(kw)) ? 0.1 : 0;
        return (b.score + bKw) - (a.score + aKw);
      })
      .slice(0, params.maxResults ?? 5);

    return scored;
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
}
