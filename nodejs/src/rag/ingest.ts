import { Embedder } from "./embedder.js";
import { ChromaVectorStore } from "./chroma-store.js";
import { MemoryVectorStore } from "./vector-store.js";
import { loadPdfDirectory } from "./pdf-loader.js";
import type { IVectorStore } from "./vector-store.js";
import { settings } from "../config/settings.js";

const PDF_DIR = settings.RAG_PDF_DIR || "D:/Chorme Downloads/国内旅游攻略pdf";

async function main() {
  console.log("=== RAG 语料入库 ===");
  console.log("PDF 目录:", PDF_DIR);

  const docs = await loadPdfDirectory(PDF_DIR);
  console.log("  → 提取", docs.length, "个文档块");
  if (docs.length === 0) { console.log("  无内容，退出"); return; }

  console.log("\n生成嵌入向量...");
  const embedder = new Embedder();
  const allEmbs: number[][] = [];
  for (let i = 0; i < docs.length; i += 10) {
    const batch = docs.slice(i, i + 10);
    const embs = await embedder.embedBatch(batch.map((d) => d.content));
    allEmbs.push(...embs);
    console.log("  " + Math.round((i + batch.length) / docs.length * 100) + "%");
  }

  let store: IVectorStore = new MemoryVectorStore("travel_guides");
  if (settings.RAG_CHROMA_URL) {
    try {
      console.log("\n尝试写入 ChromaDB:", settings.RAG_CHROMA_URL);
      const cs = new ChromaVectorStore(settings.RAG_CHROMA_URL);
      await cs.clear();
      await cs.add(docs, allEmbs);
      store = cs;
    } catch (e) {
      console.log("  ChromaDB 不可用, fallback 到 MemoryVectorStore:", (e as Error).message?.slice(0, 60));
    }
  }
  if (!store || store instanceof MemoryVectorStore) {
    console.log("\n写入 MemoryVectorStore (持久化到 data/vectors/travel_guides.json)");
    await store.clear();
    await store.add(docs, allEmbs);
  }

  const count = await store.count();
  console.log("  → 入库完成:", count, "条");

  for (const q of ["北京三日游", "成都美食", "西安兵马俑"]) {
    const vec = await embedder.embed(q);
    if (vec.length) {
      const r = await store.search(vec, 2);
      console.log("  查询[" + q + "]:", r.length, "条");
      r.forEach((x) => console.log("    " + x.document.metadata.city + " - " + x.document.metadata.title + " (" + x.score.toFixed(3) + ")"));
    }
  }
  console.log("\n完成");
}

main().catch((err) => { console.error("失败:", err); process.exit(1); });
