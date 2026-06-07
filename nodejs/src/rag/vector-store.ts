import type { RagDocument, RagSearchResult } from "./types.js";

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export interface IVectorStore {
  add(docs: RagDocument[], embeddings: number[][]): Promise<void>;
  search(queryVector: number[], topK: number, filter?: { city?: string; category?: string }): Promise<RagSearchResult[]>;
  count(): Promise<number>;
  clear(): Promise<void>;
}

export class MemoryVectorStore implements IVectorStore {
  private entries: Array<{ doc: RagDocument; embedding: number[] }> = [];

  async add(docs: RagDocument[], embeddings: number[][]): Promise<void> {
    for (let i = 0; i < docs.length; i++) {
      this.entries.push({ doc: docs[i], embedding: embeddings[i] ?? [] });
    }
  }

  async search(queryVector: number[], topK: number, filter?: { city?: string; category?: string }): Promise<RagSearchResult[]> {
    const scored = this.entries
      .filter((e) => {
        if (filter?.city && e.doc.metadata.city !== filter.city) return false;
        if (filter?.category && e.doc.metadata.category !== filter.category) return false;
        return true;
      })
      .map((e) => ({ document: e.doc, score: cosineSimilarity(queryVector, e.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    return scored;
  }

  async count(): Promise<number> { return this.entries.length; }
  async clear(): Promise<void> { this.entries = []; }
}
