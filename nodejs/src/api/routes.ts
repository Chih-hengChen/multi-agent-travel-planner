import type { FastifyInstance } from "fastify";
import { TravelStyle, PlanRequestSchema, type PlanSummary, type UserPreferences } from "../types/index.js";
import { TravelPlanningPipeline } from "../orchestrator/pipeline.js";
import { handleConversationMessage, handleSelectMessage } from "./stream-handler.js";
import { createSessionStore } from "../conversation/session-store.js";
import { InfoExtractor } from "../conversation/info-extractor.js";
import { GatheringAgent } from "../agents/gathering-agent.js";
import { TurnHandler } from "../conversation/turn-handler.js";
import { ConversationOrchestrator } from "../orchestrator/conversation-orchestrator.js";

const sessionStore = createSessionStore();
const infoExtractor = new InfoExtractor();
const gatheringAgent = new GatheringAgent();
const turnHandler = new TurnHandler(infoExtractor, gatheringAgent, new TravelPlanningPipeline());
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
    const parsed = PlanRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation failed", details: parsed.error.issues });
    }
    const req = parsed.data;

    const prefs: UserPreferences = {
      budget: req.budget,
      travelStyle: (req.travel_style as TravelStyle) ?? TravelStyle.COMFORT,
      departureCity: req.departure_city,
      startDate: req.start_date,
      endDate: req.end_date,
      numTravelers: req.num_travelers,
      interests: req.interests,
      dietaryRestrictions: [],
      accessibilityNeeds: [],
      notes: req.notes,
      outboundTransportPreference: req.outbound_transport_preference,
      returnTransportPreference: req.return_transport_preference,
      mustVisitAttractions: req.must_visit_attractions,
      departureTime: req.departure_time,
      budgetStrictness: req.budget_strictness,
      specialRequests: req.special_requests,
      accommodationType: req.accommodation_type,
      preferredStarRating: req.preferred_star_rating,
      preferredHotelBrands: req.preferred_hotel_brands,
      localTransitMode: req.local_transit_mode,
      diningPreference: req.dining_preference,
    };

    const pipeline = new TravelPlanningPipeline();
    const state = await pipeline.run(prefs);

    const dest = state.selectedDestination;
    const bb = state.budgetBreakdown;
    const days = state.activityResult?.dayPlans.length ?? 0;

    const summary: PlanSummary = {
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
    const parsed = PlanRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation failed", details: parsed.error.issues });
    }
    const req = parsed.data;

    const prefs: UserPreferences = {
      budget: req.budget,
      travelStyle: (req.travel_style as TravelStyle) ?? TravelStyle.COMFORT,
      departureCity: req.departure_city,
      startDate: req.start_date,
      endDate: req.end_date,
      numTravelers: req.num_travelers,
      interests: req.interests,
      dietaryRestrictions: [],
      accessibilityNeeds: [],
      notes: req.notes,
      outboundTransportPreference: req.outbound_transport_preference,
      returnTransportPreference: req.return_transport_preference,
      mustVisitAttractions: req.must_visit_attractions,
      departureTime: req.departure_time,
      budgetStrictness: req.budget_strictness,
      specialRequests: req.special_requests,
      accommodationType: req.accommodation_type,
      preferredStarRating: req.preferred_star_rating,
      preferredHotelBrands: req.preferred_hotel_brands,
      localTransitMode: req.local_transit_mode,
      diningPreference: req.dining_preference,
    };

    const pipeline = new TravelPlanningPipeline();
    const state = await pipeline.run(prefs);
    return reply.send(JSON.parse(JSON.stringify(state)));
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
    const body = request.body as { plan?: PlanSummary };
    if (!body?.plan) {
      return reply.status(400).send({ error: "plan is required" });
    }
    try {
      await orchestrator.handleEditPlan(sid, body.plan);
      return reply.send({ ok: true });
    } catch {
      return reply.status(404).send({ error: "Session not found" });
    }
  });
}
