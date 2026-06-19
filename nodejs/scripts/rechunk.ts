import { writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import { chunkDocument, loadFromJSONL, type ChunkConfig } from "../src/rag/corpus-loader.js";
import type { RagDocument } from "../src/rag/types.js";

const VARIANTS: Record<string, ChunkConfig> = {
  v1: { maxChars: 300, minChars: 80, overlapChars: 30 },
  v2: { maxChars: 1500, minChars: 200, overlapChars: 100 },
};

function groupByDoc(srcDocs: RagDocument[]): RagDocument[][] {
  const groups = new Map<string, RagDocument[]>();
  for (const doc of srcDocs) {
    const key = `${doc.metadata.source}|${doc.metadata.city}|${doc.metadata.title}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(doc);
  }
  for (const arr of groups.values()) {
    arr.sort((a, b) => {
      const an = parseInt(a.id.match(/(\d+)$/)?.[1] ?? "0", 10);
      const bn = parseInt(b.id.match(/(\d+)$/)?.[1] ?? "0", 10);
      return an - bn;
    });
  }
  return [...groups.values()];
}

function main() {
  const srcDir = resolve(process.argv[2] ?? "data/guides");
  if (!existsSync(srcDir)) {
    console.error(`源目录不存在: ${srcDir}`);
    process.exit(1);
  }
  const files = readdirSync(srcDir).filter(f => f.endsWith(".jsonl"));
  if (files.length === 0) {
    console.error(`源目录无 .jsonl 文件: ${srcDir}`);
    process.exit(1);
  }

  const summary: Array<{ variant: string; file: string; before: number; after: number }> = [];

  for (const [variant, config] of Object.entries(VARIANTS)) {
    const outDir = resolve(`data/guides-${variant}`);
    mkdirSync(outDir, { recursive: true });

    for (const file of files) {
      const srcDocs = loadFromJSONL(resolve(srcDir, file));
      const groups = groupByDoc(srcDocs);
      const rechunked: RagDocument[] = [];
      for (const groupDocs of groups) {
        const combined = groupDocs.map(d => d.content).join("\n\n");
        const newChunks = chunkDocument(combined, groupDocs[0].metadata, config);
        rechunked.push(...newChunks);
      }
      const outPath = resolve(outDir, basename(file));
      writeFileSync(outPath, rechunked.map(d => JSON.stringify(d)).join("\n") + "\n", "utf-8");
      console.log(`[OK] ${variant}/${basename(file)}: ${srcDocs.length} chunks / ${groups.length} docs -> ${rechunked.length} chunks`);
      summary.push({ variant, file: basename(file), before: srcDocs.length, after: rechunked.length });
    }
  }

  console.log("\n=== Summary ===");
  for (const s of summary) {
    console.log(`  ${s.variant}/${s.file}: ${s.before} -> ${s.after}`);
  }
}

main();
