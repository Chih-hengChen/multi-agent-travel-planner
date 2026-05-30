import Fastify from "fastify";
import cors from "@fastify/cors";
import { settings } from "../config/settings.js";
import { registerRoutes } from "./routes.js";

export async function createServer() {
  const app = Fastify({
    logger: {
      level: settings.LOG_LEVEL,
      transport: settings.LOG_LEVEL === "debug"
        ? { target: "pino-pretty" }
        : undefined,
    },
  });

  await app.register(cors, { origin: true });
  registerRoutes(app);
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
