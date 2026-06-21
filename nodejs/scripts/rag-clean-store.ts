import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";

const STORE_PATH = "data/vectors/travel_guides.json";
const BACKUP_PATH = "data/vectors/travel_guides.raw.json";

const CITY_SUFFIXES = [
  /^旅游攻略$/,
  /攻略$/,
  /\d+日游$/,
  /\d+日$/,
  /游记$/,
  /旅游$/,
  /指南$/,
];

function normalizeCity(c: string): string {
  if (!c) return c;
  let out = c.trim();
  for (const re of CITY_SUFFIXES) {
    if (re.test(out)) out = out.replace(re, "");
  }
  return out.length === 0 ? c : out;
}

function cleanContent(content: string): string {
  let out = content;
  out = out.replace(/^--\s*\d+\s*of\s*\d+\s*--\s*$/gm, "");
  out = out.replace(/^\[[^\]]+\]\[[^\]]+\]\s+[^\n]{1,80}?-\s+/gm, "");
  out = out.replace(/\n{3,}/g, "\n\n").trim();
  return out;
}

function main() {
  if (!existsSync(STORE_PATH)) {
    console.error(`store 不存在: ${STORE_PATH}`);
    process.exit(1);
  }
  const arr = JSON.parse(readFileSync(STORE_PATH, "utf-8"));
  console.log(`[load] ${STORE_PATH}: ${arr.length} entries`);

  if (!existsSync(BACKUP_PATH)) {
    renameSync(STORE_PATH, BACKUP_PATH);
    console.log(`[backup] ${STORE_PATH} -> ${BACKUP_PATH}`);
  } else {
    console.log(`[backup] 已存在 ${BACKUP_PATH},跳过备份`);
  }

  const cityMap: Record<string, number> = {};
  let dropped = 0;
  const cleaned: typeof arr = [];
  for (const e of arr) {
    const orig = e.doc.content ?? "";
    const content = cleanContent(orig);
    if (content.length < 20) { dropped++; continue; }
    const city = normalizeCity(e.doc.metadata.city ?? "");
    cityMap[city] = (cityMap[city] ?? 0) + 1;
    cleaned.push({
      ...e,
      doc: {
        ...e.doc,
        content,
        metadata: { ...e.doc.metadata, city },
      },
    });
  }

  console.log(`[clean] 保留 ${cleaned.length} / 丢弃 ${dropped}`);
  console.log("[clean] city top 10:");
  for (const [c, n] of Object.entries(cityMap).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${c}: ${n}`);
  }

  writeFileSync(STORE_PATH, JSON.stringify(cleaned));
  console.log(`[write] ${STORE_PATH}: ${cleaned.length} entries`);
}

main();
