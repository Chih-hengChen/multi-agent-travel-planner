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

  type Reason = "city_missing" | "topic_missing" | "low_recall";
  const failures: Array<{
    id: string; city: string; category: string; query: string;
    keywords: string[]; missingInCorpus: string[]; presentInCorpus: string[];
    cityEntries: number; reason: Reason;
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

    const cityEntryCount = entries.filter(e => e.doc.metadata.city === q.city).length;
    const missingInCorpus: string[] = [];
    const presentInCorpus: string[] = [];
    for (const kw of keywords) {
      const has = entries.some(e => e.doc.metadata.city === q.city && (e.doc.content ?? "").includes(kw));
      if (has) presentInCorpus.push(kw);
      else missingInCorpus.push(kw);
    }
    let reason: Reason;
    if (cityEntryCount === 0) reason = "city_missing";
    else if (presentInCorpus.length === 0) reason = "topic_missing";
    else reason = "low_recall";
    failures.push({ id: qid, city: q.city, category: q.category, query: q.query, keywords, missingInCorpus, presentInCorpus, cityEntries: cityEntryCount, reason });
  }

  const byCity: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const byReason: Record<Reason, number> = { city_missing: 0, topic_missing: 0, low_recall: 0 };
  const byCityReason: Record<string, { city_missing: number; topic_missing: number; low_recall: number }> = {};
  for (const f of failures) {
    byCity[f.city] = (byCity[f.city] ?? 0) + 1;
    byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
    byReason[f.reason]++;
    if (!byCityReason[f.city]) byCityReason[f.city] = { city_missing: 0, topic_missing: 0, low_recall: 0 };
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
    `| 城市缺失 (该城市 0 条目) | ${byReason.city_missing} |`,
    `| 主题缺失 (有城市条目但不含关键词) | ${byReason.topic_missing} |`,
    `| 召回不足 (关键词存在但未进 top-10) | ${byReason.low_recall} |`,
    "",
    "**判定规则 (按城市过滤)**:",
    "- 该城市 store 条目 = 0 → `city_missing` (扩语料,加城市)",
    "- 该城市有条目但所有关键词均无命中 → `topic_missing` (扩语料,补主题)",
    "- 至少一个关键词在该城市条目中存在但未进 top-10 → `low_recall` (词汇不对齐,优化检索/expansion)",
    "",
    "## 2. 按城市 x 根因",
    "",
    `| 城市 | 条目数范围 | 失败数 | 城市缺失 | 主题缺失 | 召回不足 |`,
    `|------|----------|--------|----------|----------|----------|`,
  ];
  for (const city of Object.keys(byCityReason).sort()) {
    const r = byCityReason[city];
    const avgEntries = failures.filter(f => f.city === city)[0]?.cityEntries ?? "?";
    lines.push(`| ${city} | ~${avgEntries} | ${(r.city_missing ?? 0) + (r.topic_missing ?? 0) + (r.low_recall ?? 0)} | ${r.city_missing ?? 0} | ${r.topic_missing ?? 0} | ${r.low_recall ?? 0} |`);
  }

  lines.push("", "## 3. 按类别", "", `| 类别 | 失败数 |`, `|------|--------|`);
  for (const cat of Object.keys(byCategory).sort()) {
    lines.push(`| ${cat} | ${byCategory[cat]} |`);
  }

  lines.push("", "## 4. 失败 query 明细", "");
  lines.push("### 4.1 城市缺失 (city_missing) - 需新加城市语料");
  lines.push("");
  lines.push("| id | 城市 | 类别 | query | 关键词 |");
  lines.push("|----|------|------|-------|--------|");
  for (const f of failures.filter(x => x.reason === "city_missing")) {
    lines.push(`| ${f.id} | ${f.city} | ${f.category} | ${f.query} | ${f.keywords.join(", ")} |`);
  }

  lines.push("", "### 4.2 主题缺失 (topic_missing) - 需补该城市特定主题内容");
  lines.push("");
  lines.push("| id | 城市 | 类别 | 条目数 | query | 缺失关键词 |");
  lines.push("|----|------|------|--------|-------|-------------|");
  for (const f of failures.filter(x => x.reason === "topic_missing")) {
    lines.push(`| ${f.id} | ${f.city} | ${f.category} | ${f.cityEntries} | ${f.query} | ${f.missingInCorpus.join(", ")} |`);
  }

  lines.push("", "### 4.3 召回不足 (low_recall) - 词汇不对齐,可优化检索/expansion");
  lines.push("");
  lines.push("| id | 城市 | 类别 | 条目数 | query | 存在关键词 (未召回) |");
  lines.push("|----|------|------|--------|-------|---------------------|");
  for (const f of failures.filter(x => x.reason === "low_recall")) {
    lines.push(`| ${f.id} | ${f.city} | ${f.category} | ${f.cityEntries} | ${f.query} | ${f.presentInCorpus.join(", ")} |`);
  }

  lines.push("", "## 5. 行动建议", "");
  if (byReason.city_missing > 0) {
    const cityList = [...new Set(failures.filter(f => f.reason === "city_missing").map(f => f.city))].join(", ");
    lines.push(`- **加城市语料**: ${byReason.city_missing} 条失败,缺失城市: ${cityList}`);
  }
  if (byReason.topic_missing > 0) {
    lines.push(`- **补主题内容**: ${byReason.topic_missing} 条失败,关键词在对应城市条目中完全缺失`);
  }
  if (byReason.low_recall > 0) {
    lines.push(`- **优化 expansion/检索**: ${byReason.low_recall} 条失败,关键词存在但未召回 → 词汇不对齐,需 V5 LLM 扩展`);
  }

  const outPath = resolve(resultsDir, `failure-analysis-${variantId}-${new Date().toISOString().slice(0, 10)}.md`);
  writeFileSync(outPath, lines.join("\n"));
  console.log(`\n[OK] ${outPath}`);
  console.log(`  失败总数: ${failures.length}`);
  console.log(`  语料缺失: ${byReason.no_corpus}`);
  console.log(`  召回不足: ${byReason.low_recall}`);
}

main().catch(console.error);
