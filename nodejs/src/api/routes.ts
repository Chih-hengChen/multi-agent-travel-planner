import type { FastifyInstance } from "fastify";
import { TravelStyle, PlanRequestSchema, type PlanSummary, type UserPreferences } from "../types/index.js";
import { TravelPlanningPipeline } from "../orchestrator/pipeline.js";

export function registerRoutes(app: FastifyInstance) {
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
    };

    const pipeline = new TravelPlanningPipeline();
    const state = await pipeline.run(prefs);
    return reply.send(JSON.parse(JSON.stringify(state)));
  });
}
