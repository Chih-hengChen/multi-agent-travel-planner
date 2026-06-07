import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { PDFParse } from "pdf-parse";
import type { RagDocument } from "./types.js";
import { chunkDocument } from "./corpus-loader.js";

function cityFromPath(filePath: string): string {
  const name = filePath.replace(/\.pdf$/i, "").split(/[/\\]/).pop() ?? "";
  return name.replace(/^我是驴友-/, "").replace(/旅游攻略.*$/, "").replace(/八日|三日|四日|五日|六日|两日|一日/g, "").trim() || "未知";
}

function categoryFromPath(filePath: string): string {
  const name = filePath.replace(/\.pdf$/i, "").split(/[/\\]/).pop() ?? "";
  if (/美食|吃/.test(name)) return "food";
  if (/路线|行程|攻略$/.test(name)) return "itinerary";
  return "tips";
}

export async function extractPdfText(filePath: string): Promise<string> {
  const buffer = new Uint8Array(readFileSync(filePath));
  const parser = new PDFParse(buffer);
  const result = await parser.getText({});
  return result?.text ?? "";
}

export async function loadPdfDirectory(dirPath: string): Promise<RagDocument[]> {
  const allDocs: RagDocument[] = [];
  const entries = readdirSync(dirPath);
  for (const entry of entries) {
    const fullPath = resolve(dirPath, entry);
    if (statSync(fullPath).isDirectory()) {
      allDocs.push(...await loadPdfDirectory(fullPath));
    } else if (entry.toLowerCase().endsWith(".pdf")) {
      try {
        const text = await extractPdfText(fullPath);
        if (!text || text.length < 50) continue;
        const title = entry.replace(/\.pdf$/i, "");
        const docs = chunkDocument(text, { city: cityFromPath(entry), source: "pdf", category: categoryFromPath(entry), title });
        allDocs.push(...docs);
      } catch (err) {
        console.warn("跳过:", entry, (err as Error).message?.slice(0, 60));
      }
    }
  }
  return allDocs;
}
