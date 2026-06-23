import type { FastifyInstance } from "fastify";
import { handleConversationMessage, handleSelectMessage } from "./stream-handler.js";
import { createSessionStore } from "../conversation/session-store.js";
import { InfoExtractor } from "../conversation/info-extractor.js";
import { GatheringAgent } from "../agents/gathering-agent.js";
import { TurnHandler } from "../conversation/turn-handler.js";
import { TravelPlanningPipeline } from "../orchestrator/pipeline.js";
import { ConversationOrchestrator } from "../orchestrator/conversation-orchestrator.js";
import { saveUserRating, listRatedSessions, saveSessionFeedback } from "../feedback/feedback-store.js";
import { settings } from "../config/settings.js";

const sessionStore = createSessionStore();
const infoExtractor = new InfoExtractor();
const gatheringAgent = new GatheringAgent();
const pipeline = settings.USE_AGENT_LOOP ? undefined : new TravelPlanningPipeline();
const turnHandler = new TurnHandler(infoExtractor, gatheringAgent, undefined, undefined, pipeline);
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

  app.post("/api/plan", async (request, reply) => {
    if (settings.USE_AGENT_LOOP) {
      return reply.status(410).send({
        error: "POST /api/plan deprecated with Agent Loop. Use POST /api/chat/:sid instead.",
      });
    }

    const { PlanRequestSchema } = await import("../types/index.js");
    const { TravelStyle } = await import("../types/index.js");

    const parsed = PlanRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation failed", details: parsed.error.issues });
    }
    const req = parsed.data as Record<string, unknown>;

    const prefs = {
      budget: Number(req.budget) || 0,
      travelStyle: req.travel_style ?? TravelStyle.COMFORT,
      preferredDestination: req.departure_city,
      departureCity: req.departure_city as string,
      startDate: req.start_date as string,
      endDate: req.end_date as string,
      numTravelers: Number(req.num_travelers) || 1,
      interests: (Array.isArray(req.interests) ? req.interests : []) as string[],
      dietaryRestrictions: [] as string[],
      accessibilityNeeds: [] as string[],
      notes: (req.notes as string) ?? "",
      outboundTransportPreference: (req.outbound_transport_preference ?? "no_preference") as "flight" | "high_speed_rail" | "train" | "no_preference",
      returnTransportPreference: (req.return_transport_preference ?? "no_preference") as "flight" | "high_speed_rail" | "train" | "no_preference",
      mustVisitAttractions: (Array.isArray(req.must_visit_attractions) ? req.must_visit_attractions : []) as string[],
      departureTime: (req.departure_time ?? "flexible") as "morning" | "afternoon" | "evening" | "flexible",
      budgetStrictness: (req.budget_strictness ?? "strict") as "strict" | "flexible" | "luxury",
      specialRequests: (req.special_requests as string) ?? "",
      accommodationType: (req.accommodation_type ?? "any") as "hotel" | "homestay" | "resort" | "any",
      preferredStarRating: Number(req.preferred_star_rating) || undefined,
      preferredHotelBrands: (Array.isArray(req.preferred_hotel_brands) ? req.preferred_hotel_brands : []) as string[],
      localTransitMode: (req.local_transit_mode ?? "mixed") as "public_transit" | "taxi" | "rental_car" | "mixed",
      diningPreference: (req.dining_preference ?? "local_specialties") as "trending" | "local_specialties" | "mixed",
    };

    const state = await pipeline!.run(prefs as import("../types/index.js").UserPreferences);

    const dest = state.selectedDestination;
    const bb = state.budgetBreakdown;
    const days = state.activityResult?.dayPlans?.length ?? 0;

    const summary = {
      destination: dest?.city ?? "",
      country: dest?.country ?? "",
      flightCost: bb?.flightCost ?? 0,
      trainCost: bb?.trainCost ?? 0,
      hotelCost: bb?.hotelCost ?? 0,
      activityCost: bb?.activityCost ?? 0,
      totalCost: bb?.totalCost ?? 0,
      budget: bb?.budget ?? 0,
      withinBudget: bb?.isWithinBudget ?? true,
      adjustmentRounds: state.adjustmentRound,
      hotelName: state.hotelResult?.recommended?.name ?? "",
      days,
      highlights: dest?.highlights ?? [],
      warnings: state.errorMessages,
      transportMode: state.transportMode,
      outboundFlights: state.flightResult?.outboundFlights ?? [],
      returnFlights: state.flightResult?.returnFlights ?? [],
      trainOutbound: state.trainOutbound ?? null,
      trainReturn: state.trainReturn ?? null,
      hotels: state.hotelResult?.hotels ?? [],
      dayPlans: state.activityResult?.dayPlans ?? [],
    };
    return reply.send(summary);
  });

  app.post("/api/plan/full", async (request, reply) => {
    if (settings.USE_AGENT_LOOP) {
      return reply.status(410).send({
        error: "POST /api/plan/full deprecated with Agent Loop. Use POST /api/chat/:sid instead.",
      });
    }

    const { PlanRequestSchema } = await import("../types/index.js");
    const parsed = PlanRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation failed", details: parsed.error.issues });
    }

    const state = await pipeline!.run(request.body as any);
    return reply.send(state);
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
