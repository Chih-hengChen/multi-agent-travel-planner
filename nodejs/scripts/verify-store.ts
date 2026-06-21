import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

interface EvalQuery {
  id: string;
  category: string;
  city: string;
  query: string;
  groundTruthDocIds: string[];
}

interface StoreEntry {
  doc: {
    id: string;
    content: string;
    metadata: {
      city: string;
      category: string;
      title: string;
      source: string;
    };
  };
  embedding: number[];
}

const CITY_SUFFIXES = [/攻略$/, /\d+日$/, /旅游$/, /游记$/, /指南$/];

function normalizeCity(c: string): string {
  if (!c) return c;
  let out = c.trim();
  for (const re of CITY_SUFFIXES) if (re.test(out)) out = out.replace(re, "");
  return out.length === 0 ? c : out;
}

function cityMatches(evalCity: string, docCity: string): boolean {
  if (docCity === evalCity) return true;
  if (docCity && docCity.startsWith(evalCity)) return true;
  const norm = normalizeCity(docCity);
  return norm === evalCity;
}

function keywordsFromQuery(q: EvalQuery, city: string): string[] {
  const prefix = `travel_guides_${city}_`;
  return q.groundTruthDocIds
    .map(id => (id.startsWith(prefix) ? id.slice(prefix.length) : id))
    .filter(k => k.length > 0);
}

function section(title: string) {
  console.log("\n" + "=".repeat(70));
  console.log(title);
  console.log("=".repeat(70));
}

function layer1CityCheck(evalSet: EvalQuery[], store: StoreEntry[]): string[] {
  section("Layer 1: Store City Health Check");
  const storeCityCount: Record<string, number> = {};
  for (const e of store) {
    const c = e.doc.metadata.city ?? "<empty>";
    storeCityCount[c] = (storeCityCount[c] ?? 0) + 1;
  }
  console.log(`store 总计 ${store.length} entries,${Object.keys(storeCityCount).length} 个唯一 city`);
  console.log("city top 10:");
  for (const [c, n] of Object.entries(storeCityCount).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${c}: ${n}`);
  }

  const evalCities = [...new Set(evalSet.map(q => q.city))];
  console.log(`\neval set ${evalCities.length} 个 city:${evalCities.join(", ")}`);
  console.log("\ncity 匹配表:");
  console.log("  city            | exact | fuzzy | normalized | status");
  console.log("  ----------------|-------|-------|------------|--------");

  const blockers: string[] = [];
  for (const city of evalCities) {
    const exact = store.filter(e => e.doc.metadata.city === city).length;
    const fuzzy = store.filter(e => (e.doc.metadata.city ?? "").includes(city)).length;
    const normalized = store.filter(e => normalizeCity(e.doc.metadata.city ?? "") === city).length;
    let status = "OK";
    if (exact === 0 && fuzzy === 0) {
      status = "MISSING";
      blockers.push(`city "${city}" 在 store 中无任何匹配(exact=0, fuzzy=0)— 语料缺失`);
    } else if (exact === 0 && fuzzy > 0) {
      status = "BLOCKER";
      blockers.push(`city "${city}" exact=0 但 fuzzy=${fuzzy} — 字段命名不一致,请先规范化 metadata.city`);
    } else if (exact < fuzzy * 0.5) {
      status = "WARN";
    }
    console.log(`  ${city.padEnd(15)} | ${String(exact).padStart(5)} | ${String(fuzzy).padStart(5)} | ${String(normalized).padStart(10)} | ${status}`);
  }
  return blockers;
}

function layer3OracleTest(evalSet: EvalQuery[], store: StoreEntry[]): { oracleHits: number; perCity: Record<string, { total: number; oracle: number }> } {
  section("Layer 3: Oracle Test(语料覆盖 vs 检索算法 分离)");
  console.log("对每条 query 全文扫描 store:city 匹配 + content 含 keyword = oracle 可达");
  console.log("oracle=false → 语料覆盖问题(优化检索算法无意义)");
  console.log("oracle=true  → 检索算法可能提升\n");

  let oracleHits = 0;
  const perCity: Record<string, { total: number; oracle: number }> = {};

  for (const q of evalSet) {
    const keywords = keywordsFromQuery(q, q.city);
    const oracleHit = store.some(e =>
      cityMatches(q.city, e.doc.metadata.city ?? "") &&
      keywords.some(k => (e.doc.content ?? "").includes(k)),
    );
    if (oracleHit) oracleHits++;
    if (!perCity[q.city]) perCity[q.city] = { total: 0, oracle: 0 };
    perCity[q.city].total++;
    if (oracleHit) perCity[q.city].oracle++;
  }

  console.log(`Oracle 覆盖率:${oracleHits}/${evalSet.length} (${(oracleHits / evalSet.length * 100).toFixed(1)}%)`);
  console.log(`  → oracle=true (语料可达): ${oracleHits}`);
  console.log(`  → oracle=false (语料缺失/keyword 不在 store): ${evalSet.length - oracleHits}`);
  console.log("\n按城市 oracle 覆盖率:");
  console.log("  city            | oracle/total | 覆盖率");
  console.log("  ----------------|--------------|-------");
  for (const [city, s] of Object.entries(perCity)) {
    const pct = (s.oracle / s.total * 100).toFixed(0);
    console.log(`  ${city.padEnd(15)} | ${String(s.oracle).padStart(3)}/${String(s.total).padEnd(3)}      | ${pct}%`);
  }

  console.log("\n解释:");
  console.log("  - 若 Oracle 覆盖率 < Hit@5 目标(85%),说明 eval set 的 ground truth 覆盖范围超 store,");
  console.log("    再优化检索算法也救不回 oracle=false 的 query — 应该扩语料或修 eval set。");
  console.log("  - 若 Oracle=100% 但 retriever Hit@5 低,才是检索算法问题。");
  return { oracleHits, perCity };
}

function main() {
  const evalSetPath = process.argv[2] ?? "data/rag/eval-v1.jsonl";
  const storePath = process.argv[3] ?? "data/vectors/travel_guides.json";

  if (!existsSync(resolve(evalSetPath))) {
    console.error(`eval set 不存在: ${evalSetPath}`);
    process.exit(2);
  }
  if (!existsSync(resolve(storePath))) {
    console.error(`store 不存在: ${storePath}`);
    process.exit(2);
  }

  const evalSet: EvalQuery[] = readFileSync(resolve(evalSetPath), "utf-8")
    .split("\n").filter(Boolean).map(l => JSON.parse(l));
  const store: StoreEntry[] = JSON.parse(readFileSync(resolve(storePath), "utf-8"));

  console.log(`[verify-store] eval set: ${evalSet.length} queries from ${evalSetPath}`);
  console.log(`[verify-store] store: ${store.length} entries from ${storePath}`);

  const blockers = layer1CityCheck(evalSet, store);
  layer3OracleTest(evalSet, store);

  section("结论");
  if (blockers.length > 0) {
    console.log(`❌ ${blockers.length} BLOCKER — 必须先修复再跑 variant 实验:`);
    for (const b of blockers) console.log(`  - ${b}`);
    console.log("\n修复建议:");
    console.log("  1. 跑 `tsx scripts/rag-clean-store.ts` 规范化 city 字段");
    console.log("  2. 检查 eval set 的 city 写法与 store 是否一致");
    console.log("  3. 修复后重跑本脚本确认 BLOCKER 清空");
    process.exit(1);
  } else {
    console.log("✅ Store 健康检查通过,可以跑 variant 实验");
    process.exit(0);
  }
}

main();
