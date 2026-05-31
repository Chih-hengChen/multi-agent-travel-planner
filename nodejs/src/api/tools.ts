import pino from "pino";
import { TravelStyle, type UserPreferences, type PlanSummary } from "../types/index.js";
import { TravelPlanningPipeline } from "../orchestrator/pipeline.js";
import type { ToolDef } from "./llm-client.js";

const log = pino({ level: "info", transport: { target: "pino-pretty", options: { colorize: false, translateTime: "SYS:HH:MM:ss" } } });

export const TOOLS: ToolDef[] = [
  {
    name: "plan_travel",
    description:
      "根据用户旅行偏好生成完整行程方案，包括目的地推荐、航班、酒店、每日活动和预算分析。当用户提供了目的地、出发城市、出发/返回日期和预算信息后调用此工具。",
    input_schema: {
      type: "object",
      properties: {
        destination: {
          type: "string",
          description: "目的地城市名称，如：北京、东京、巴黎",
        },
        departure_city: {
          type: "string",
          description: "出发城市，如：上海、广州",
        },
        start_date: {
          type: "string",
          description: "出发日期，格式 YYYY-MM-DD",
        },
        end_date: {
          type: "string",
          description: "返回日期，格式 YYYY-MM-DD",
        },
        budget: {
          type: "number",
          description: "总预算（人民币，元）",
        },
        travel_style: {
          type: "string",
          enum: ["budget", "comfort", "luxury", "adventure", "cultural", "relaxation"],
          description: "旅行风格，默认 comfort",
        },
        num_travelers: {
          type: "number",
          description: "出行人数，默认 1",
        },
        interests: {
          type: "array",
          items: { type: "string" },
          description: "兴趣标签，如：美食、博物馆、购物、自然风光",
        },
        transport_preference: {
          type: "string",
          enum: ["flight", "high_speed_rail", "train", "no_preference"],
          description: "交通偏好，默认 no_preference",
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
        special_requests: {
          type: "string",
          description: "特殊需求，如：必须去环球影城",
        },
      },
      required: ["destination", "departure_city", "start_date", "end_date", "budget"],
    },
  },
];

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  if (name !== "plan_travel") {
    return { error: `Unknown tool: ${name}` };
  }

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
    transportPreference: (input.transport_preference as UserPreferences["transportPreference"]) ?? "no_preference",
    departureTime: (input.departure_time as UserPreferences["departureTime"]) ?? "flexible",
    budgetStrictness: (input.budget_strictness as UserPreferences["budgetStrictness"]) ?? "strict",
    specialRequests: input.special_requests ? String(input.special_requests) : undefined,
  };

  const pipeline = new TravelPlanningPipeline(log);
  const state = await pipeline.run(prefs);

  const dest = state.selectedDestination;
  const bb = state.budgetBreakdown;
  const days = state.activityResult?.dayPlans.length ?? 0;

  const result: PlanSummary = {
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

  return result;
}
