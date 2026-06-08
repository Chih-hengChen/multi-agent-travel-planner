import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { settings } from "../config/settings.js";
import { registerRoutes } from "./routes.js";

if (process.platform === "win32") {
  try { execSync("chcp 65001", { stdio: "ignore" }); } catch {}
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function warmupVectorStore(logger: { info: (o: Record<string, unknown>, m: string) => void }) {
  if (!settings.RAG_ENABLED) return;
  try {
    const { RagSource } = await import("../rag/rag-source.js");
    const rag = new RagSource();
    await rag.ensureInit();
    const stats = await rag.getStats();
    logger.info({ docs: stats.totalDocs, store: settings.RAG_CHROMA_URL ? "chroma" : "memory" }, "rag: warmed up");
  } catch { /* best-effort */ }
}

export async function createServer() {
  const app = Fastify({
    logger: {
      level: settings.LOG_LEVEL,
      transport: { target: "pino-pretty", options: { colorize: false, translateTime: "SYS:HH:MM:ss" } },
    },
  });

  await app.register(cors, { origin: true });
  await app.register(fastifyStatic, {
    root: path.join(__dirname, "../public"),
    prefix: "/",
  });
  registerRoutes(app);

  warmupVectorStore(app.log);

  return app;
}

const isMain = process.argv[1]?.endsWith("app.ts") || process.argv[1]?.endsWith("app.js");
if (isMain) {
  createServer().then(async (app) => {
    try {
      await app.listen({ host: settings.API_HOST, port: settings.API_PORT });
    } catch (err) {
      app.log.error(err);
      process.exit(1);
    }
  });
}
