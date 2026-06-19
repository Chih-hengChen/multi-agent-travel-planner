import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

process.env.RAG_CHROMA_URL = "";
import { RagSource, type RagVariant } from "../src/rag/rag-source.js";

interface EvalQuery {
  id: string;
  category: string;
  city: string;
  query: string;
  groundTruthDocIds: string[];
}

interface EvalResult {
  variantId: string;
  timestamp: string;
  metrics: {
    hitRateAt5: number;
    hitRateAt10: number;
    mrr: number;
    ndcgAt10: number;
    recallAt5: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
  };
  perCategory: Record<string, { hitRateAt5: number; mrr: number }>;
  perQueryHits: number[];
  perQueryRanks: (number | null)[];
  failedQueries: string[];
}

function p(arr: number[], percentile: number): number {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil((percentile / 100) * s.length) - 1)];
}

function ndcgAt10(hits: number[], k: number): number {
  const dcg = hits.slice(0, k).reduce((sum, rel, i) =>
    sum + (Math.pow(2, rel) - 1) / Math.log2(i + 2), 0);
  const idealCount = Math.min(hits.length, k);
  const idcg = Array.from({ length: idealCount }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
  return idcg === 0 ? 0 : dcg / idcg;
}

async function main() {
  const variantArg = process.argv[2] ?? "v0";
  const variantId = variantArg;
  const ragVariant: RagVariant = (["v0", "v3", "v4", "v5"].includes(variantArg) ? variantArg : "v0") as RagVariant;
  const evalSetPath = process.argv[3] ?? "data/rag/eval-v1.jsonl";
  const outputDir = "data/rag/eval-results";

  if (!existsSync(resolve(evalSetPath))) {
    console.error(`评估集不存在: ${evalSetPath}`);
    process.exit(1);
  }

  const queries: EvalQuery[] = readFileSync(resolve(evalSetPath), "utf-8")
    .split("\n").filter(Boolean).map(l => JSON.parse(l));
  console.log(`[${variantId}] (ragVariant=${ragVariant}) 查询: ${queries.length} 条`);

  const rag = new RagSource(undefined, ragVariant);
  const latencies: number[] = [];
  const results: Array<{ cat: string; hit5: boolean; hit10: boolean; rank: number | null }> = [];
  const byCategory: Record<string, number[]> = {};

  for (const q of queries) {
    const start = Date.now();
    const docs = await rag.search({ city: q.city, query: q.query, maxResults: 10 });
    latencies.push(Date.now() - start);

    const keywords = q.groundTruthDocIds
      .map(id => {
        const prefix = `travel_guides_${q.city}_`;
        return id.startsWith(prefix) ? id.slice(prefix.length) : id;
      })
      .filter(k => k.length > 0);

    const firstHitIdx = docs.findIndex(d =>
      keywords.some(k => (d.document.content ?? "").includes(k)),
    );
    const hit = firstHitIdx >= 0;

    results.push({ cat: q.category, hit5: hit && firstHitIdx < 5, hit10: hit, rank: hit ? firstHitIdx + 1 : null });
    if (!byCategory[q.category]) byCategory[q.category] = [];
    if (hit) byCategory[q.category].push(firstHitIdx + 1);
  }

  const hitAt5 = results.filter(r => r.hit5).length / queries.length;
  const hitAt10 = results.filter(r => r.hit10).length / queries.length;
  const mrr = results.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / queries.length;
  const recallAt5 = results.filter(r => r.hit5).length / queries.length;
  const hits = results.map(r => r.hit10 ? 1 : 0);
  const ndcg = ndcgAt10(hits, 10);
  const avgLat = latencies.reduce((a, b) => a + b, 0) / latencies.length;

  const result: EvalResult = {
    variantId,
    timestamp: new Date().toISOString(),
    metrics: {
      hitRateAt5: +hitAt5.toFixed(4),
      hitRateAt10: +hitAt10.toFixed(4),
      mrr: +mrr.toFixed(4),
      ndcgAt10: +ndcg.toFixed(4),
      recallAt5: +recallAt5.toFixed(4),
      avgLatencyMs: +avgLat.toFixed(0),
      p95LatencyMs: +p(latencies, 95).toFixed(0),
    },
    perCategory: Object.fromEntries(
      Object.entries(byCategory).map(([cat, ranks]) => {
        const catHits = ranks.length;
        const catCount = results.filter(r => r.cat === cat).length;
        const catMrr = ranks.reduce((s, r) => s + 1 / r, 0) / catCount;
        return [cat, { hitRateAt5: catHits / catCount, mrr: +catMrr.toFixed(4) }];
      })
    ),
    perQueryHits: results.map(r => r.hit10 ? 1 : 0),
    perQueryRanks: results.map(r => r.rank),
    failedQueries: results.filter(r => !r.hit10).map((_, i) => queries[i].id),
  };

  if (!existsSync(resolve(outputDir))) mkdirSync(resolve(outputDir), { recursive: true });
  const outPath = resolve(`${outputDir}/eval-${variantId}-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\n[${variantId}] 结果: ${outPath}`);
  console.log(`  Hit Rate@5:  ${(hitAt5 * 100).toFixed(1)}%`);
  console.log(`  Hit Rate@10: ${(hitAt10 * 100).toFixed(1)}%`);
  console.log(`  MRR:         ${mrr.toFixed(4)}`);
  console.log(`  NDCG@10:     ${ndcg.toFixed(4)}`);
  console.log(`  avg latency: ${avgLat.toFixed(0)}ms`);
  console.log(`  失败 queries: ${result.failedQueries.length}/${queries.length}`);
}

main().catch(console.error);
