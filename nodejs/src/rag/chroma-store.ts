import { ChromaClient } from "chromadb";
import type { RagDocument, RagSearchResult } from "./types.js";
import type { IVectorStore } from "./vector-store.js";

const COLLECTION_NAME = "travel_guides";

export class ChromaVectorStore implements IVectorStore {
  private client: ChromaClient;
  private collection: any = null;

  constructor(chromaUrl?: string) {
    this.client = new ChromaClient({ path: chromaUrl ?? "http://localhost:8000" });
  }

  async ensureCollection(): Promise<void> {
    if (this.collection) return;
    this.collection = await this.client.getOrCreateCollection({
      name: COLLECTION_NAME,
      metadata: { "hnsw:space": "cosine" },
    });
  }

  async add(docs: RagDocument[], embeddings: number[][]): Promise<void> {
    await this.ensureCollection();
    await this.collection.add({
      ids: docs.map((d) => d.id),
      embeddings,
      metadatas: docs.map((d) => ({ city: d.metadata.city, source: d.metadata.source, category: d.metadata.category, title: d.metadata.title })),
      documents: docs.map((d) => d.content),
    });
  }

  async search(queryVector: number[], topK: number, filter?: { city?: string; category?: string }): Promise<RagSearchResult[]> {
    await this.ensureCollection();
    const where: Record<string, any> = {};
    if (filter?.city) where.city = filter.city;
    if (filter?.category) where.category = filter.category;

    const results: any = await this.collection.query({
      queryEmbeddings: [queryVector],
      nResults: topK,
      where: Object.keys(where).length > 0 ? where : undefined,
    });

    const ids: string[] = results.ids?.[0] ?? [];
    const docs: string[] = results.documents?.[0] ?? [];
    const dists: number[] = results.distances?.[0] ?? [];
    const metas: any[] = (results.metadatas as any[])?.[0] ?? [];

    return ids.map((id, i) => ({
      document: {
        id,
        content: docs[i] ?? "",
        metadata: {
          city: metas[i]?.city ?? "",
          source: metas[i]?.source ?? "chroma",
          category: metas[i]?.category ?? "tips",
          title: metas[i]?.title ?? "",
        },
      },
      score: dists[i] !== undefined ? 1 - dists[i] : 0,
    }));
  }

  async count(): Promise<number> {
    await this.ensureCollection();
    return this.collection.count();
  }

  async clear(): Promise<void> {
    try { await this.client.deleteCollection({ name: COLLECTION_NAME }); } catch { /* ignore */ }
    this.collection = null;
  }
}
