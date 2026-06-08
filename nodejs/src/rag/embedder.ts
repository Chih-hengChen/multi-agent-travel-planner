import { settings } from "../config/settings.js";

const CACHE_SIZE = 500;

export class Embedder {
  private cache = new Map<string, number[]>();

  clearCache(): void { this.cache.clear(); }

  async embed(text: string): Promise<number[]> {
    const cached = this.cache.get(text);
    if (cached) return cached;

    if (this.cache.size >= CACHE_SIZE) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }

    try {
      const vector = await this.callEmbeddingApi(text);
      this.cache.set(text, vector);
      return vector;
    } catch {
      return [];
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }

  private async callEmbeddingApi(text: string): Promise<number[]> {
    const baseUrl = settings.RAG_EMBEDDING_BASE_URL.replace(/\/+$/, "");
    const url = baseUrl.includes("/paas/v4") ? baseUrl + "/embeddings" : baseUrl + "/v1/embeddings";
    const apiKey = settings.RAG_EMBEDDING_API_KEY;

    const body: Record<string, unknown> = {
      model: settings.RAG_EMBEDDING_MODEL,
      input: text,
    };

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error("Embedding API " + resp.status + " " + errText.slice(0, 100));
    }

    const data = await resp.json() as { data?: Array<{ embedding: number[] }> };
    const emb = data.data?.[0]?.embedding;
    if (!emb?.length) throw new Error("Empty embedding");
    return emb;
  }
}
