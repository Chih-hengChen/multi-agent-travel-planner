import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
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

const PERSIST_DIR = resolve(process.cwd(), "data/vectors");

export class MemoryVectorStore implements IVectorStore {
  private entries: Array<{ doc: RagDocument; embedding: number[] }> = [];
  private persistPath = "";

  constructor(persistKey?: string) {
    if (persistKey) {
      this.persistPath = resolve(PERSIST_DIR, persistKey + ".json");
      this.loadFromDisk();
    }
  }

  async add(docs: RagDocument[], embeddings: number[][]): Promise<void> {
    for (let i = 0; i < docs.length; i++) {
      this.entries.push({ doc: docs[i], embedding: embeddings[i] ?? [] });
    }
    this.saveToDisk();
  }

  async search(queryVector: number[], topK: number, filter?: { city?: string; category?: string }): Promise<RagSearchResult[]> {
    const scored = this.entries
      .filter((e) => {
        if (filter?.city) {
          const dc = e.doc.metadata.city;
          if (dc !== filter.city && !(dc && dc.startsWith(filter.city))) return false;
        }
        if (filter?.category && e.doc.metadata.category !== filter.category) return false;
        return true;
      })
      .map((e) => ({ document: e.doc, score: cosineSimilarity(queryVector, e.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    return scored;
  }

  async count(): Promise<number> { return this.entries.length; }

  async clear(): Promise<void> {
    this.entries = [];
    this.saveToDisk();
  }

  private saveToDisk(): void {
    if (!this.persistPath) return;
    try {
      if (!existsSync(PERSIST_DIR)) mkdirSync(PERSIST_DIR, { recursive: true });
      const data = this.entries.map((e) => ({ doc: e.doc, embedding: Array.from(e.embedding) }));
      writeFileSync(this.persistPath, JSON.stringify(data));
    } catch { /* persistence is best-effort */ }
  }

  private loadFromDisk(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.persistPath, "utf-8")) as Array<{ doc: RagDocument; embedding: number[] }>;
      this.entries = raw;
    } catch { /* ignore corrupt cache */ }
  }
}
