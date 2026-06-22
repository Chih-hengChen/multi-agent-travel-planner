import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { resolve } from "node:path";

process.env.RAG_CHROMA_URL = "";
import { chunkDocument, type ChunkConfig } from "../src/rag/corpus-loader.js";
import { Embedder } from "../src/rag/embedder.js";
import type { RagDocument } from "../src/rag/types.js";

const STORE_PATH = resolve("data/vectors/travel_guides.json");
const BACKUP_PATH = resolve("data/vectors/travel_guides.clean-v1.json");

const REBUILD_CONFIG: ChunkConfig = { maxChars: 600, minChars: 100, overlapChars: 100 };

const ISOLATED_LINE_WORDS = new Set([
  "目录", "CATALOG", "关于", "ABOUT", "印象", "IMPRESSION",
  "费用", "天数", "舒适程度", "关键词", "概述", "亮点",
  "景点", "活动", "住宿", "餐饮", "购物", "交通",
  "实用信息", "背景", "线路推荐", "有问必答", "更多路线",
  "No.1", "No.2", "No.3", "No.4", "心愿单", "舒适",
]);

function isNoiseLine(line: string): boolean {
  const t = line.trim();
  if (t.length === 0) return false;
  if (/^\d{1,4}$/.test(t)) return true;
  if (ISOLATED_LINE_WORDS.has(t)) return true;
  if (/^第[一二三四五六七八九十百]+[章节篇部分]?$/.test(t)) return true;
  if (/^[一二三四五六七八九十]{1,3}[、.\s]$/.test(t)) return true;
  if (t.includes("\t")) {
    const stripped = t.replace(/\t/g, "");
    if (stripped.length < 15) return true;
  }
  if (/[·•]/.test(t) && t.length < 30) return true;
  if (/^[一-龥]{2,6}[·•][一-龥]{0,8}攻略$/.test(t)) return true;
  if (/^[一-龥]{2,6}手绘地图$/.test(t)) return true;
  if (/^跟着[它他她]们去旅行/.test(t)) return true;
  if (/^([一-龥]{1,5}\s+){2,}[一-龥]{1,5}$/.test(t) && t.length < 50) return true;
  if (/^\d+天$/.test(t)) return true;
  if (/^\d+[-\d]*元$/.test(t)) return true;
  if (/^\d+[-~]\d+元$/.test(t)) return true;
  if (/^[a-zA-Z]+\d*$/.test(t) && t.length < 15) return true;
  if (/^更多线路[一-龥]*$/.test(t)) return true;
  if (/^——[一-龥]{2,15}$/.test(t)) return true;
  if (/^心愿单/.test(t) && t.length < 30) return true;
  return false;
}

function mergeParagraphs(text: string, targetSize: number): string {
  const paras = text.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 0);
  const merged: string[] = [];
  let buf = "";
  for (const p of paras) {
    if (buf.length + p.length + 1 <= targetSize) {
      buf = buf ? buf + " " + p : p;
    } else {
      if (buf) merged.push(buf);
      buf = p;
    }
  }
  if (buf) merged.push(buf);
  return merged.join("\n\n");
}

function deepClean(text: string): string {
  let out = text.replace(/\r\n/g, "\n").replace(/^--\s*\d+\s*of\s*\d+\s*--\s*$/gm, "");
  const lines = out.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (t.length === 0) {
      if (kept.length > 0 && kept[kept.length - 1] !== "") kept.push("");
      continue;
    }
    if (isNoiseLine(line)) continue;
    kept.push(t);
  }
  out = kept.join("\n");
  out = out.replace(/([^\n])\n([^\n])/g, "$1$2");
  out = out.replace(/ {2,}/g, " ");
  out = out.replace(/([。！？])/g, "$1\n\n");
  out = out.split("\n").map(l => l.trim()).filter(() => true).join("\n");
  out = out.replace(/\n{3,}/g, "\n\n").trim();
  out = mergeParagraphs(out, 500);
  return out;
}

function removeChunkOverlap(chunks: string[]): string[] {
  if (chunks.length === 0) return [];
  const result = [chunks[0]];
  for (let i = 1; i < chunks.length; i++) {
    const prev = result[result.length - 1];
    const curr = chunks[i];
    const maxL = Math.min(curr.length, prev.length, 250);
    let overlap = 0;
    for (let L = maxL; L >= 30; L--) {
      if (prev.endsWith(curr.slice(0, L))) { overlap = L; break; }
    }
    result.push(overlap > 0 ? curr.slice(overlap) : curr);
  }
  return result;
}

interface StoreEntry { doc: RagDocument; embedding: number[]; }

function groupByDoc(entries: StoreEntry[]): StoreEntry[][] {
  const groups = new Map<string, StoreEntry[]>();
  for (const e of entries) {
    const m = e.doc.metadata;
    const key = `${m.source}|${m.city}|${m.title}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e);
  }
  for (const arr of groups.values()) {
    arr.sort((a, b) => {
      const an = parseInt(a.doc.id.match(/(\d+)$/)?.[1] ?? "0", 10);
      const bn = parseInt(b.doc.id.match(/(\d+)$/)?.[1] ?? "0", 10);
      return an - bn;
    });
  }
  return [...groups.values()];
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  if (!existsSync(STORE_PATH)) {
    console.error(`store 不存在: ${STORE_PATH}`);
    process.exit(1);
  }
  const arr: StoreEntry[] = JSON.parse(readFileSync(STORE_PATH, "utf-8"));
  console.log(`[load] ${STORE_PATH}: ${arr.length} entries`);

  if (!existsSync(BACKUP_PATH)) {
    renameSync(STORE_PATH, BACKUP_PATH);
    console.log(`[backup] -> ${BACKUP_PATH}`);
  } else {
    console.log(`[backup] 已存在 ${BACKUP_PATH},跳过`);
  }

  const groups = groupByDoc(arr);
  console.log(`[group] ${groups.length} 个原始文档(按 source|city|title 聚合)`);

  const newDocs: RagDocument[] = [];
  let droppedGroups = 0;
  for (const group of groups) {
    const deduped = removeChunkOverlap(group.map(e => e.doc.content));
    const rawText = deduped.join("");
    const cleaned = deepClean(rawText);
    if (cleaned.length < 50) {
      droppedGroups++;
      continue;
    }
    const meta = { ...group[0].doc.metadata };
    const chunks = chunkDocument(cleaned, meta, REBUILD_CONFIG);
    for (const c of chunks) {
      if (c.content.trim().length >= REBUILD_CONFIG.minChars) newDocs.push(c);
    }
  }
  console.log(`[rechunk] ${newDocs.length} 新 chunks (from ${arr.length} entries, 丢弃 ${droppedGroups} 个清洗后过短文档)`);
  const lens = newDocs.map(d => d.content.length);
  if (lens.length > 0) {
    const avg = Math.round(lens.reduce((a, b) => a + b, 0) / lens.length);
    console.log(`[rechunk] chunk 长度: min=${Math.min(...lens)} avg=${avg} max=${Math.max(...lens)}`);
  }

  const embedder = new Embedder();
  const embeddings: number[][] = [];
  const BATCH = 30;
  let emptyCount = 0;
  for (let i = 0; i < newDocs.length; i += BATCH) {
    const slice = newDocs.slice(i, i + BATCH);
    const vecs = await embedder.embedBatch(slice.map(d => d.content));
    for (const v of vecs) {
      embeddings.push(v);
      if (v.length === 0) emptyCount++;
    }
    const done = Math.min(i + BATCH, newDocs.length);
    if (done % 100 < BATCH || done === newDocs.length) {
      console.log(`[embed] ${done}/${newDocs.length} (empty=${emptyCount})`);
    }
    await sleep(50);
  }
  if (emptyCount > 0) {
    console.log(`[embed] ⚠️ ${emptyCount} 条返回空向量(API 失败,需检查 .env RAG_EMBEDDING_*)`);
  }

  const newEntries: StoreEntry[] = newDocs.map((doc, i) => ({ doc, embedding: embeddings[i] ?? [] }));
  writeFileSync(STORE_PATH, JSON.stringify(newEntries));
  console.log(`[write] ${STORE_PATH}: ${newEntries.length} entries`);

  const byCity: Record<string, number> = {};
  for (const e of newEntries) {
    const c = e.doc.metadata.city ?? "<empty>";
    byCity[c] = (byCity[c] ?? 0) + 1;
  }
  console.log("[write] city top 10:");
  for (const [c, n] of Object.entries(byCity).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${c}: ${n}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
