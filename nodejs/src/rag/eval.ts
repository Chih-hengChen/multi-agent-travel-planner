import { readFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
process.env.RAG_CHROMA_URL = "";
import { RagSource } from "./rag-source.js";

interface EvalQuery { city: string; query: string; expected: string[]; mustCity?: string; category?: string }

interface EvalCheck {
  query: string; city: string; keyword: string; category: string;
  hit: boolean; rank: number; topScore: number; latency: number;
}

function p(arr: number[], percentile: number): number {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil((percentile / 100) * s.length) - 1)];
}

function ndcgAt10(checks: EvalCheck[]): number {
  const dcg = checks.slice(0, 10).reduce((sum, c, i) => {
    const rel = c.hit ? 1 : 0;
    return sum + (Math.pow(2, rel) - 1) / Math.log2(i + 2);
  }, 0);
  const idealCount = Math.min(checks.length, 10);
  const idcg = Array.from({ length: idealCount }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
  return idcg === 0 ? 0 : dcg / idcg;
}

function precisionAtK(checks: EvalCheck[], k: number): number {
  return checks.slice(0, k).filter(c => c.hit).length / k;
}

async function main() {
  console.log("=== RAG 评估 v2 ===\n");

  const queries: EvalQuery[] = readFileSync(resolve("data/eval/rag-queries.jsonl"), "utf-8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  console.log("测试集:", queries.length, "条查询\n");

  const checks: EvalCheck[] = [];
  const latencies: number[] = [];

  for (const q of queries) {
    const rag = new RagSource();
    const start = Date.now();
    const results = await rag.search({ city: q.city, query: q.query, maxResults: 10 });
    const latency = Date.now() - start;
    latencies.push(latency);

    for (const kw of q.expected) {
      const idx = results.findIndex((r) => r.document.content.includes(kw));
      checks.push({
        query: q.query, city: q.city, keyword: kw, category: q.category ?? "unknown",
        hit: idx >= 0, rank: idx >= 0 ? idx + 1 : 0,
        topScore: results[0]?.score ?? 0, latency,
      });
    }
  }

  const totalQueries = queries.length;
  const totalChecks = checks.length;
  const hits = checks.filter((c) => c.hit);
  const hitRate = hits.length / totalChecks;
  const mrr = hits.reduce((s, c) => s + 1 / c.rank, 0) / totalChecks;
  const recall = hits.length / totalChecks;
  const ndcg = ndcgAt10(checks);
  const prec5 = precisionAtK(checks, 5);
  const avgLat = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const date = new Date().toISOString().slice(0, 19).replace("T", " ");

  console.log("╔════════════════════════════════════════╗");
  console.log("║        RAG 基线评估报告 v2            ║");
  console.log("╚════════════════════════════════════════╝\n");
  console.log("时间:", date);
  console.log("测试:", totalQueries, "查询 /", totalChecks, "验证项");
  console.log("向量存储: MemoryVectorStore | 嵌入: text-embedding-3-small");
  console.log("Chunk: 500 | overlap 80 | min 100 | topK 5\n");

  console.log("─── 核心指标 ───");
  console.log("  Hit Rate:     " + (hitRate * 100).toFixed(1) + "%  (" + hits.length + "/" + totalChecks + ")");
  console.log("  MRR:          " + mrr.toFixed(4));
  console.log("  Recall@10:    " + (recall * 100).toFixed(1) + "%");
  console.log("  NDCG@10:      " + ndcg.toFixed(4));
  console.log("  Precision@5:  " + (prec5 * 100).toFixed(1) + "%");
  console.log("  平均延迟:     " + avgLat.toFixed(0) + "ms");
  console.log("  延迟 P50:     " + p(latencies, 50) + "ms");
  console.log("  延迟 P95:     " + p(latencies, 95) + "ms\n");

  console.log("─── 按 Category 统计 ───");
  const categories = [...new Set(checks.map(c => c.category))];
  for (const cat of categories) {
    const catChecks = checks.filter(c => c.category === cat);
    const catHits = catChecks.filter(c => c.hit);
    const catRate = catHits.length / catChecks.length;
    console.log("  " + cat.padEnd(14) + (catRate * 100).toFixed(1) + "%  (" + catHits.length + "/" + catChecks.length + ")");
  }
  console.log();

  console.log("─── 每条详情 ───");
  for (const q of queries) {
    const c = checks.filter((x) => x.query === q.query && x.city === q.city);
    const hit = c.some((x) => x.hit);
    const cat = q.category ?? "?";
    console.log("  " + (hit ? "✓" : "✗") + " [" + q.city + "] [" + cat + "] \"" + q.query + "\"");
    for (const cc of c) {
      const icon = cc.hit ? "命中 @" + cc.rank : "未命中";
      console.log("    " + icon + " 关键词=" + cc.keyword);
    }
    console.log("    latency: " + (c[0]?.latency ?? 0) + "ms  topScore: " + (c[0]?.topScore ?? 0).toFixed(3));
  }

  const bl = { date, hitRate: +hitRate.toFixed(4), mrr: +mrr.toFixed(4), recall: +recall.toFixed(4), ndcg: +ndcg.toFixed(4), precisionAt5: +prec5.toFixed(4), avgLatency: +avgLat.toFixed(0), p50: p(latencies, 50), p95: p(latencies, 95), totalQueries, totalChecks, config: { chunkSize: 500, overlap: 80, minChars: 100, topK: 5 } };
  appendFileSync(resolve("data/eval/baseline.jsonl"), JSON.stringify(bl) + "\n");
  console.log("\n  → 基线已追加到 data/eval/baseline.jsonl");
  console.log("\n=== 评估完成 ===");
}

main().catch(console.error);
