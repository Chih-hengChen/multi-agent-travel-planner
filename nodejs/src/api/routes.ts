import type { FastifyInstance } from "fastify";
import { handleConversationMessage, handleSelectMessage } from "./stream-handler.js";
import { createSessionStore } from "../conversation/session-store.js";
import { InfoExtractor } from "../conversation/info-extractor.js";
import { GatheringAgent } from "../agents/gathering-agent.js";
import { TurnHandler } from "../conversation/turn-handler.js";
import { ConversationOrchestrator } from "../orchestrator/conversation-orchestrator.js";
import { saveUserRating, listRatedSessions, saveSessionFeedback } from "../feedback/feedback-store.js";

const sessionStore = createSessionStore();
const infoExtractor = new InfoExtractor();
const gatheringAgent = new GatheringAgent();
const turnHandler = new TurnHandler(infoExtractor, gatheringAgent);
const orchestrator = new ConversationOrchestrator(sessionStore, turnHandler);

export function registerRoutes(app: FastifyInstance) {
  app.get("/", async (_request, reply) => {
    return reply.redirect("/chat.html");
  });

  app.get("/api/health", async () => ({
    status: "ok",
    service: "travel-planner",
    agents: 6,
  }));

  app.post("/api/plan", async (_request, reply) => {
    return reply.status(410).send({
      error: "POST /api/plan deprecated. Use POST /api/chat/:sid with Agent Loop instead.",
    });
  });

  app.post("/api/plan/full", async (_request, reply) => {
    return reply.status(410).send({
      error: "POST /api/plan/full deprecated. Use POST /api/chat/:sid with Agent Loop instead.",
    });
  });

  app.post("/api/chat", async (_request, reply) => {
    const sessionId = await orchestrator.createSession();
    return reply.send({ sessionId });
  });

  app.post("/api/chat/:sid", async (request, reply) => {
    await handleConversationMessage(request as any, reply, orchestrator);
  });

  app.post("/api/chat/:sid/select", async (request, reply) => {
    await handleSelectMessage(request as any, reply, orchestrator);
  });

  app.get("/api/chat/:sid/state", async (request, reply) => {
    const { sid } = (request as any).params as { sid: string };
    const state = await orchestrator.getSessionState(sid);
    if (!state) return reply.status(404).send({ error: "Session not found" });
    return reply.send(state);
  });

  app.delete("/api/chat/:sid", async (request, reply) => {
    const { sid } = (request as any).params as { sid: string };
    await orchestrator.deleteSession(sid);
    return reply.send({ ok: true });
  });

  app.put("/api/chat/:sid/plan", async (request, reply) => {
    const { sid } = (request as any).params as { sid: string };
    const body = request.body as { plan?: unknown };
    if (!body?.plan) {
      return reply.status(400).send({ error: "plan is required" });
    }
    try {
      await orchestrator.handleEditPlan(sid, body.plan as any);
      return reply.send({ ok: true });
    } catch {
      return reply.status(404).send({ error: "Session not found" });
    }
  });

  app.post("/api/feedback", async (request, reply) => {
    const body = request.body as {
      sid: string;
      plan?: Record<string, unknown>;
      traceSummary?: Record<string, unknown>;
      userMessage?: string;
    };
    if (!body.sid) {
      return reply.status(400).send({ error: "sid is required" });
    }
    saveSessionFeedback(body.sid, {
      plan: (body.plan ?? {}) as any,
      traceSummary: (body.traceSummary ?? {}) as any,
      userMessage: body.userMessage ?? "",
    });
    return reply.send({ ok: true });
  });

  app.post("/api/feedback/:sid/rate", async (request, reply) => {
    const { sid } = (request as any).params as { sid: string };
    const body = request.body as { score?: number; feedback?: string };
    if (!body.score || body.score < 1 || body.score > 5) {
      return reply.status(400).send({ error: "score must be 1-5" });
    }
    const ok = saveUserRating(sid, {
      score: body.score,
      feedback: body.feedback,
      ratedAt: new Date().toISOString(),
    });
    if (!ok) return reply.status(404).send({ error: "Session not found" });
    return reply.send({ ok: true });
  });

  app.get("/api/feedback/sessions", async () => {
    return { sessions: listRatedSessions() };
  });
}
