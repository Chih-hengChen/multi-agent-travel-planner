import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { RagDocument, ChunkStrategy, Section } from "./types.js";

export interface ChunkConfig { maxChars: number; minChars: number; overlapChars: number; }
const DEFAULT_CONFIG: ChunkConfig = { maxChars: 500, minChars: 100, overlapChars: 80 };
export const TECH_CONFIG: ChunkConfig = { maxChars: 1200, minChars: 150, overlapChars: 200 };

export class TravelDocStrategy implements ChunkStrategy {
  readonly name = "travel";
  detectSections(text: string): Section[] {
    return text.split(/(?=## )/).filter(Boolean).map(s => ({ content: s.trim() }));
  }
}

export class TechDocStrategy implements ChunkStrategy {
  readonly name = "tech";

  detectSections(text: string): Section[] {
    const sections: Section[] = [];
    const lines = text.split("\n");
    let buffer: string[] = [];
    let inCodeBlock = false;
    let inTable = false;
    let bufferStart = 0;

    const flush = (atomic = false) => {
      if (buffer.length > 0) {
        const content = buffer.join("\n").trim();
        if (content) sections.push({ content, atomic, lineNumber: bufferStart });
        buffer = [];
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.trimStart().startsWith("```")) {
        if (inCodeBlock) {
          buffer.push(line);
          flush(true);
          inCodeBlock = false;
          continue;
        }
        flush();
        inCodeBlock = true;
        bufferStart = i;
        buffer.push(line);
        continue;
      }

      if (inCodeBlock) { buffer.push(line); continue; }

      if (line.includes("|") && line.trim().startsWith("|")) {
        if (!inTable) { flush(); bufferStart = i; inTable = true; }
        buffer.push(line);
        continue;
      } else if (inTable) {
        flush(true);
        inTable = false;
      }

      if (/^#{1,4}\s/.test(line) && buffer.length > 0) {
        flush();
        bufferStart = i;
      }

      buffer.push(line);
    }

    flush(inTable);
    return sections;
  }
}

export function chunkDocument(
  text: string,
  metadata: RagDocument["metadata"],
  config = DEFAULT_CONFIG,
  strategy: ChunkStrategy = new TravelDocStrategy(),
): RagDocument[] {
  const sections = strategy.detectSections(text);
  const chunks: RagDocument[] = [];
  let idx = 0;

  for (const section of sections) {
    if (section.atomic || section.content.length <= config.maxChars) {
      chunks.push(makeChunk(section.content, metadata, ++idx, section.atomic ? "section" : undefined));
      continue;
    }
    const paragraphs = section.content.split(/\n\n+/).filter(Boolean);
    for (const para of paragraphs) {
      if (para.length <= config.maxChars) {
        chunks.push(makeChunk(para, metadata, ++idx, "paragraph"));
      } else {
        for (let i = 0; i < para.length; i += config.maxChars - config.overlapChars) {
          const end = Math.min(i + config.maxChars, para.length);
          const t = "[" + metadata.city + "][" + metadata.category + "] " + metadata.title + " - " + para.slice(i, end);
          if (t.length >= config.minChars) chunks.push(makeChunk(t, metadata, ++idx, "paragraph"));
        }
      }
    }
  }
  return chunks;
}

function makeChunk(content: string, metadata: RagDocument["metadata"], idx: number, chunkType?: RagDocument["metadata"]["chunkType"]): RagDocument {
  return {
    id: metadata.source + "_" + metadata.city + "_" + String(idx).padStart(4, "0"),
    content: content.slice(0, 600),
    metadata: { ...metadata, ...(chunkType ? { chunkType } : {}) },
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
