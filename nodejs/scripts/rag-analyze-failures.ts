import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

process.env.RAG_CHROMA_URL = "";
import { RagSource } from "../src/rag/rag-source.js";
import type { RagDocument } from "../src/rag/types.js";

interface EvalQuery {
  id: string;
  category: string;
  city: string;
  query: string;
  groundTruthDocIds: string[];
}

interface EvalResult {
  variantId: string;
  failedQueries: string[];
  perQueryRanks: (number | null)[];
}

function pickLatest(resultsDir: string, prefix: string): string | null {
  const files = readdirSync(resultsDir)
    .filter(f => f.startsWith(`${prefix}-`) && f.endsWith(".json"))
    .sort()
    .reverse();
  return files[0] ? resolve(resultsDir, files[0]) : null;
}

async function main() {
  const resultsDir = resolve(process.argv[2] ?? "data/rag/eval-results");
  const variantId = process.argv[3] ?? "v0";
  const evalSetPath = resolve(process.argv[4] ?? "data/rag/eval-v1.jsonl");

  if (!existsSync(resultsDir)) {
    console.error(`结果目录不存在: ${resultsDir}`);
    process.exit(1);
  }
  const resultFile = pickLatest(resultsDir, `eval-${variantId}`);
  if (!resultFile) {
    console.error(`未找到 ${variantId} 的 eval 结果`);
    process.exit(1);
  }
  const result = JSON.parse(readFileSync(resultFile, "utf-8")) as EvalResult;
  const queries = readFileSync(evalSetPath, "utf-8")
    .split("\n").filter(Boolean).map(l => JSON.parse(l) as EvalQuery);
  const qById = new Map(queries.map(q => [q.id, q]));

  console.log(`[${variantId}] 加载 store 检查语料覆盖...`);
  const rag = new RagSource();
  await rag.ensureInit();
  const store = (rag as any).store;
  const entries: Array<{ doc: RagDocument }> = store.entries ?? store._entries ?? [];
  console.log(`  store 共 ${entries.length} 条 chunk`);

  type Reason = "no_corpus" | "low_recall";
  const failures: Array<{
    id: string; city: string; category: string; query: string;
    keywords: string[]; missingInCorpus: string[]; presentInCorpus: string[];
    reason: Reason;
  }> = [];

  for (const qid of result.failedQueries) {
    const q = qById.get(qid);
    if (!q) continue;
    const keywords = q.groundTruthDocIds
      .map(id => {
        const prefix = `travel_guides_${q.city}_`;
        return id.startsWith(prefix) ? id.slice(prefix.length) : id;
      })
      .filter(k => k.length > 0);

    const missingInCorpus: string[] = [];
    const presentInCorpus: string[] = [];
    for (const kw of keywords) {
      const has = entries.some(e => (e.doc.content ?? "").includes(kw));
      if (has) presentInCorpus.push(kw);
      else missingInCorpus.push(kw);
    }
    const reason: Reason = presentInCorpus.length === 0 ? "no_corpus" : "low_recall";
    failures.push({ id: qid, city: q.city, category: q.category, query: q.query, keywords, missingInCorpus, presentInCorpus, reason });
  }

  const byCity: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const byReason: Record<Reason, number> = { no_corpus: 0, low_recall: 0 };
  const byCityReason: Record<string, { no_corpus: number; low_recall: number }> = {};
  for (const f of failures) {
    byCity[f.city] = (byCity[f.city] ?? 0) + 1;
    byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
    byReason[f.reason]++;
    if (!byCityReason[f.city]) byCityReason[f.city] = { no_corpus: 0, low_recall: 0 };
    byCityReason[f.city][f.reason]++;
  }

  const lines: string[] = [
    "# RAG 失败 Query 分析",
    "",
    `> variant: ${variantId}`,
    `> 数据源: ${resultFile}`,
    `> eval set: ${evalSetPath}`,
    `> 生成时间: ${new Date().toISOString()}`,
    `> store chunks: ${entries.length}`,
    "",
    "## 1. 总览",
    "",
    `| 维度 | 数量 |`,
    `|------|------|`,
    `| 失败 query 总数 | ${failures.length} |`,
    `| 语料缺失 (no_corpus) | ${byReason.no_corpus} |`,
    `| 召回不足 (low_recall) | ${byReason.low_recall} |`,
    "",
    "**判定规则**: 对每条失败 query 的 ground truth 关键词,扫描整个 chunk store:",
    "- 所有关键词在 store 中均无 chunk.content.includes(kw) 命中 -> `no_corpus` (语料缺失,任何检索算法都救不回)",
    "- 至少有一个关键词在 store 中存在但未进 top-10 -> `low_recall` (召回/阈值/排序问题,可优化)",
    "",
    "## 2. 按城市 x 根因",
    "",
    `| 城市 | 失败数 | 语料缺失 | 召回不足 |`,
    `|------|--------|----------|----------|`,
  ];
  for (const city of Object.keys(byCityReason).sort()) {
    const r = byCityReason[city];
    lines.push(`| ${city} | ${(r.no_corpus ?? 0) + (r.low_recall ?? 0)} | ${r.no_corpus ?? 0} | ${r.low_recall ?? 0} |`);
  }

  lines.push("", "## 3. 按类别", "", `| 类别 | 失败数 |`, `|------|--------|`);
  for (const cat of Object.keys(byCategory).sort()) {
    lines.push(`| ${cat} | ${byCategory[cat]} |`);
  }

  lines.push("", "## 4. 失败 query 明细", "");
  lines.push("### 4.1 语料缺失 (no_corpus) - 需扩语料");
  lines.push("");
  lines.push("| id | 城市 | 类别 | query | 关键词 (全部缺失) |");
  lines.push("|----|------|------|-------|-------------------|");
  for (const f of failures.filter(x => x.reason === "no_corpus")) {
    lines.push(`| ${f.id} | ${f.city} | ${f.category} | ${f.query} | ${f.missingInCorpus.join(", ")} |`);
  }

  lines.push("", "### 4.2 召回不足 (low_recall) - 可优化检索");
  lines.push("");
  lines.push("| id | 城市 | 类别 | query | 缺失关键词 | 存在关键词 (未召回) |");
  lines.push("|----|------|------|-------|------------|---------------------|");
  for (const f of failures.filter(x => x.reason === "low_recall")) {
    lines.push(`| ${f.id} | ${f.city} | ${f.category} | ${f.query} | ${f.missingInCorpus.join(", ") || "-"} | ${f.presentInCorpus.join(", ")} |`);
  }

  lines.push("", "## 5. 行动建议", "");
  if (byReason.no_corpus > 0) {
    lines.push(`- **扩语料**: ${byReason.no_corpus} 条失败 query 的关键词在 store 中完全缺失,优先扩充这些城市/类别的 chunk。`);
  }
  if (byReason.low_recall > 0) {
    lines.push(`- **优化召回**: ${byReason.low_recall} 条失败 query 的关键词存在于 store 但未进 top-10,排查:`);
    lines.push(`  1. SIMILARITY_THRESHOLD=0.3 是否过严`);
    lines.push(`  2. keyword fallback 触发条件是否合理`);
    lines.push(`  3. V3 hybrid / V5 query expansion 是否能救回`);
  }

  const outPath = resolve(resultsDir, `failure-analysis-${variantId}-${new Date().toISOString().slice(0, 10)}.md`);
  writeFileSync(outPath, lines.join("\n"));
  console.log(`\n[OK] ${outPath}`);
  console.log(`  失败总数: ${failures.length}`);
  console.log(`  语料缺失: ${byReason.no_corpus}`);
  console.log(`  召回不足: ${byReason.low_recall}`);
}

main().catch(console.error);
