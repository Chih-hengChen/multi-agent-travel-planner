import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as readline from "node:readline";

process.env.RAG_CHROMA_URL = "";
import { RagSource } from "../src/rag/rag-source.js";

interface EvalItem {
  id: string;
  category: string;
  city: string;
  query: string;
}

interface LabeledItem extends EvalItem {
  groundTruthDocIds: string[];
  reviewer: string;
  version: string;
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("用法: npx tsx scripts/label-tool.ts <eval-jsonl-path>");
    process.exit(1);
  }

  const queries: EvalItem[] = readFileSync(resolve(inputPath), "utf-8")
    .split("\n").filter(Boolean).map(l => JSON.parse(l));
  console.log(`加载 ${queries.length} 条 query, 开始标注...\n`);

  const rag = new RagSource();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const labeled: LabeledItem[] = [];

  for (const q of queries) {
    console.log(`\n[${q.id}] (${q.category}) ${q.city}: ${q.query}`);
    console.log("-".repeat(60));

    const results = await rag.search({ city: q.city, query: q.query, maxResults: 20 });
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      console.log(`  [${i + 1}] score=${r.score.toFixed(3)} ${r.document.content.slice(0, 80)}...`);
    }

    const answer = await new Promise<string>(resolve => {
      rl.question("相关编号(逗号分隔,空跳过): ", resolve);
    });

    const groundTruthDocIds = answer
      .split(",").map(s => s.trim()).filter(Boolean)
      .map(n => results[parseInt(n) - 1]?.document.id)
      .filter(Boolean);

    labeled.push({
      ...q,
      groundTruthDocIds,
      reviewer: process.env.USER ?? "unknown",
      version: "v1",
    });
  }

  rl.close();
  const outPath = resolve(inputPath.replace(".jsonl", "-labeled.jsonl"));
  writeFileSync(outPath, labeled.map(l => JSON.stringify(l)).join("\n"));
  console.log(`\n标注结果已写入: ${outPath}`);
  console.log(`共标注 ${labeled.length} 条, 其中 ${labeled.filter(l => l.groundTruthDocIds.length > 0).length} 条有正样本`);
}

main().catch(console.error);
