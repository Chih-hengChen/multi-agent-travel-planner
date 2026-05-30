import type { FastifyInstance } from "fastify";
import { TravelStyle, PlanRequestSchema, type PlanSummary, type UserPreferences } from "../types/index.js";
import { TravelPlanningPipeline } from "../orchestrator/pipeline.js";
import { handleChatStream } from "./stream-handler.js";

export function registerRoutes(app: FastifyInstance) {
  app.get("/", async (_request, reply) => {
    return reply.redirect("/chat.html");
  });

  app.post("/api/chat/stream", async (request, reply) => {
    const body = request.body as { message?: string };
    if (!body?.message) {
      return reply.status(400).send({ error: "message is required" });
    }
    await handleChatStream(request as any, reply);
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
      transportPreference: req.transport_preference,
      departureTime: req.departure_time,
      budgetStrictness: req.budget_strictness,
      specialRequests: req.special_requests,
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
      transportPreference: req.transport_preference,
      departureTime: req.departure_time,
      budgetStrictness: req.budget_strictness,
      specialRequests: req.special_requests,
    };

    const pipeline = new TravelPlanningPipeline();
    const state = await pipeline.run(prefs);
    return reply.send(JSON.parse(JSON.stringify(state)));
  });
}
