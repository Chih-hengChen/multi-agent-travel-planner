import type { RagSearchParams, RagSearchResult, RagSourceStats, RagDocument } from "./types.js";
import { Embedder } from "./embedder.js";
import { MemoryVectorStore, type IVectorStore } from "./vector-store.js";
import { loadSeedDirectory, convertBaikeToDocs, convertXhsToDocs } from "./corpus-loader.js";
import { settings } from "../config/settings.js";
import type { Logger } from "pino";

const SIMILARITY_THRESHOLD = 0.3;

export class RagSource {
  private embedder = new Embedder();
  private store: IVectorStore = new MemoryVectorStore();
  private initialized = false;
  private log?: Logger;

  constructor(log?: Logger) { this.log = log; }

  async ensureInit(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    if (!settings.RAG_ENABLED) {
      this.log?.info("rag: disabled by config");
      return;
    }

    const seeds = loadSeedDirectory();
    if (seeds.length > 0) {
      this.log?.info({ count: seeds.length }, "rag: loading seed guides");
      await this.addDocuments(seeds);
      this.log?.info({ total: await this.store.count() }, "rag: seed loaded");
    }
  }

  async addDocuments(docs: RagDocument[]): Promise<void> {
    const texts = docs.map((d) => d.content);
    const embeddings = await this.embedder.embedBatch(texts);
    await this.store.add(docs, embeddings);
  }

  async search(params: RagSearchParams): Promise<RagSearchResult[]> {
    await this.ensureInit();
    if (!settings.RAG_ENABLED) return [];

    const queryVector = await this.embedder.embed(params.query);
    if (queryVector.length === 0) return [];

    const topK = (params.maxResults ?? 5) * 2;
    const results = await this.store.search(queryVector, topK, {
      city: params.city,
      category: params.category && params.category !== "all" ? params.category : undefined,
    });

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
    const results = await this.search(params);
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
