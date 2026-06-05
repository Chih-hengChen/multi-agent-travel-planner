import { TravelStyle, type UserPreferences, type PlanSummary } from "../../types/index.js";
import { TravelPlanningPipeline } from "../../orchestrator/pipeline.js";
import type { RegisteredTool } from "../types.js";
import pino, { type Logger } from "pino";

export function createPlanTravelTool(log?: Logger): RegisteredTool {
  const logger = log ?? pino({ level: "info" });

  return {
    name: "plan_travel",
    description:
      "根据用户旅行偏好生成完整行程方案，包括目的地推荐、航班、酒店、每日活动和预算分析。当用户提供了目的地、出发城市、出发/返回日期和预算信息后调用此工具。",
    input_schema: {
      type: "object",
      properties: {
        destination: { type: "string", description: "目的地城市名称，如：北京、东京、巴黎" },
        departure_city: { type: "string", description: "出发城市，如：上海、广州" },
        start_date: { type: "string", description: "出发日期，格式 YYYY-MM-DD" },
        end_date: { type: "string", description: "返回日期，格式 YYYY-MM-DD" },
        budget: { type: "number", description: "总预算（人民币，元）" },
        travel_style: {
          type: "string",
          enum: ["budget", "comfort", "luxury", "adventure", "cultural", "relaxation"],
          description: "旅行风格，默认 comfort",
        },
        num_travelers: { type: "number", description: "出行人数，默认 1" },
        interests: {
          type: "array",
          items: { type: "string" },
          description: "兴趣标签，如：美食、博物馆、购物、自然风光",
        },
        outbound_transport_preference: {
          type: "string",
          enum: ["flight", "high_speed_rail", "train", "no_preference"],
          description: "去程交通偏好，默认 no_preference",
        },
        return_transport_preference: {
          type: "string",
          enum: ["flight", "high_speed_rail", "train", "no_preference"],
          description: "返程交通偏好，默认 no_preference",
        },
        must_visit_attractions: {
          type: "array",
          items: { type: "string" },
          description: "必须游览的景点列表",
        },
        departure_time: {
          type: "string",
          enum: ["morning", "afternoon", "evening", "flexible"],
          description: "偏好出发时间，默认 flexible",
        },
        budget_strictness: {
          type: "string",
          enum: ["strict", "flexible", "luxury"],
          description: "预算严格程度，默认 strict",
        },
        special_requests: { type: "string", description: "特殊需求，如：必须去环球影城" },
        accommodation_type: {
          type: "string",
          enum: ["hotel", "homestay", "resort", "any"],
          description: "住宿类型偏好，默认 any",
        },
        preferred_star_rating: { type: "number", description: "偏好酒店星级 1-5" },
        preferred_hotel_brands: {
          type: "array",
          items: { type: "string" },
          description: "偏好酒店品牌，如：希尔顿、万豪",
        },
        local_transit_mode: {
          type: "string",
          enum: ["public_transit", "taxi", "rental_car", "mixed"],
          description: "市内交通方式，默认 mixed",
        },
        dining_preference: {
          type: "string",
          enum: ["trending", "local_specialties", "mixed"],
          description: "餐饮偏好，默认 mixed",
        },
      },
      required: ["destination", "departure_city", "start_date", "end_date", "budget"],
    },
    metadata: { category: "planning", timeout: 120_000 },
    execute: async (input) => {
      try {
        const prefs: UserPreferences = {
          budget: Number(input.budget) || 10000,
          travelStyle: (input.travel_style as TravelStyle) ?? TravelStyle.COMFORT,
          departureCity: String(input.departure_city ?? "北京"),
          startDate: String(input.start_date ?? "2026-06-01"),
          endDate: String(input.end_date ?? "2026-06-05"),
          numTravelers: Number(input.num_travelers) || 1,
          interests: Array.isArray(input.interests) ? input.interests.map(String) : [],
          dietaryRestrictions: [],
          accessibilityNeeds: [],
          notes: String(input.special_requests ?? ""),
          preferredDestination: String(input.destination),
          outboundTransportPreference: (input.outbound_transport_preference as UserPreferences["outboundTransportPreference"]) ?? "no_preference",
          returnTransportPreference: (input.return_transport_preference as UserPreferences["returnTransportPreference"]) ?? "no_preference",
          mustVisitAttractions: Array.isArray(input.must_visit_attractions) ? input.must_visit_attractions.map(String) : [],
          departureTime: (input.departure_time as UserPreferences["departureTime"]) ?? "flexible",
          budgetStrictness: (input.budget_strictness as UserPreferences["budgetStrictness"]) ?? "strict",
          specialRequests: input.special_requests ? String(input.special_requests) : undefined,
          accommodationType: (input.accommodation_type as UserPreferences["accommodationType"]) ?? "any",
          preferredStarRating: input.preferred_star_rating ? Number(input.preferred_star_rating) : undefined,
          preferredHotelBrands: Array.isArray(input.preferred_hotel_brands) ? input.preferred_hotel_brands.map(String) : [],
          localTransitMode: (input.local_transit_mode as UserPreferences["localTransitMode"]) ?? "mixed",
          diningPreference: (input.dining_preference as UserPreferences["diningPreference"]) ?? "mixed",
        };

        const pipeline = new TravelPlanningPipeline(logger);
        const state = await pipeline.run(prefs);

        const dest = state.selectedDestination;
        const bb = state.budgetBreakdown;
        const days = state.activityResult?.dayPlans.length ?? 0;

        const result: PlanSummary = {
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

        return { success: true, data: result };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, data: null, error: msg };
      }
    },
  };
}
