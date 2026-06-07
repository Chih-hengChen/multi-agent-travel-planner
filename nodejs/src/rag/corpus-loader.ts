import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { RagDocument } from "./types.js";

export interface ChunkConfig { maxChars: number; minChars: number; overlapChars: number; }
const DEFAULT_CONFIG: ChunkConfig = { maxChars: 500, minChars: 100, overlapChars: 80 };

export function chunkDocument(text: string, metadata: RagDocument["metadata"], config = DEFAULT_CONFIG): RagDocument[] {
  const chunks: RagDocument[] = [];
  const sections = text.split(/(?=## )/).filter(Boolean);

  let idx = 0;
  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    if (trimmed.length <= config.maxChars) {
      chunks.push(makeChunk(trimmed, metadata, ++idx));
      continue;
    }

    const paragraphs = trimmed.split(/\n\n+/).filter(Boolean);
    for (const para of paragraphs) {
      if (para.length <= config.maxChars) {
        chunks.push(makeChunk(para, metadata, ++idx));
      } else {
        for (let i = 0; i < para.length; i += config.maxChars - config.overlapChars) {
          const end = Math.min(i + config.maxChars, para.length);
          const t = "[" + metadata.city + "][" + metadata.category + "] " + metadata.title + " - " + para.slice(i, end);
          if (t.length >= config.minChars) chunks.push(makeChunk(t, metadata, ++idx));
        }
      }
    }
  }
  return chunks;
}

function makeChunk(content: string, metadata: RagDocument["metadata"], idx: number): RagDocument {
  return {
    id: metadata.source + "_" + metadata.city + "_" + String(idx).padStart(4, "0"),
    content: content.slice(0, 600),
    metadata: { ...metadata },
  };
}

export function loadFromJSONL(filePath: string): RagDocument[] {
  const content = readFileSync(resolve(filePath), "utf-8");
  return content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as RagDocument);
}

export function loadSeedDirectory(dataDir?: string): RagDocument[] {
  const dir = resolve(dataDir ?? process.cwd(), "data/guides");
  const docs: RagDocument[] = [];
  try {
    for (const file of readdirSync(dir)) {
      if (file.endsWith(".jsonl")) docs.push(...loadFromJSONL(resolve(dir, file)));
    }
  } catch { /* directory may not exist */ }
  return docs;
}

export function convertBaikeToDocs(city: string, content: string): RagDocument[] {
  return chunkDocument(content, { city, source: "baike", category: "tips", title: city + "百科" });
}

export function convertXhsToDocs(notes: Array<{ title: string; content: string }>, city: string): RagDocument[] {
  const docs: RagDocument[] = [];
  for (const note of notes) {
    const text = note.title + "\n" + (note.content ?? "");
    const category = text.includes("美食") || text.includes("吃") ? "food" : text.includes("路线") || text.includes("行程") ? "itinerary" : "tips";
    docs.push(...chunkDocument(text, { city, source: "xhs", category, title: note.title }));
  }
  return docs;
}
