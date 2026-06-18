import { z } from "zod";
import { jsonrepair } from "jsonrepair";
import { TravelPlanSchema } from "../schemas/travel-plan.js";
import { ActivitySchema } from "../schemas/activity.js";
import { TransitSegmentSchema } from "../schemas/transit.js";
import { DiningPlanSchema } from "../schemas/dining.js";
import { ItinerarySlotSchema } from "../schemas/itinerary.js";
import { DayPlanSchema } from "../schemas/day-plan.js";
import { BudgetBreakdownSchema } from "../schemas/budget.js";

export {
  TravelPlanSchema,
  ActivitySchema,
  TransitSegmentSchema,
  DiningPlanSchema,
  ItinerarySlotSchema,
  DayPlanSchema,
  BudgetBreakdownSchema,
};

export type {
  TravelPlan,
  PlanActivity,
  PlanTransitSegment,
  PlanDayPlan,
  PlanBudgetBreakdown,
  PlanDiningPlan,
  PlanItinerarySlot,
} from "../schemas/index.js";

export class JsonRepairExhaustedError extends Error {
  constructor(
    message: string,
    public readonly rawExcerpt: string,
    public readonly lastError?: unknown,
  ) {
    super(message);
    this.name = "JsonRepairExhaustedError";
  }
}

const PlanSchema = TravelPlanSchema;

function stripCodeFences(raw: string): string {
  return raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
}

function repairJson(raw: string): string {
  const cleaned = stripCodeFences(raw);
  try {
    return jsonrepair(cleaned);
  } catch {
    return simpleRepair(cleaned);
  }
}

function extractOutermostBlock(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

function simpleRepair(s: string): string {
  let repaired = s;
  repaired = repaired.replace(/,(\s*[}\]])/g, "$1");
  repaired = repaired.replace(/:\s*'([^']*)'/g, ': "$1"');
  repaired = repaired.replace(/(\w+)\s*:/g, (match, key) =>
    /^[A-Za-z_$][\w$]*$/.test(key) ? `"${key}":` : match
  );
  const open = (repaired.match(/{/g) ?? []).length;
  const close = (repaired.match(/}/g) ?? []).length;
  if (open > close) repaired += "}".repeat(open - close);
  const openBr = (repaired.match(/\[/g) ?? []).length;
  const closeBr = (repaired.match(/\]/g) ?? []).length;
  if (openBr > closeBr) repaired += "]".repeat(openBr - closeBr);
  return repaired;
}

export function parsePlanLoose(raw: string): z.infer<typeof TravelPlanSchema> {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new JsonRepairExhaustedError("Empty input", raw?.slice(0, 200) ?? "");
  }

  // 第 1 层: brace-balanced 提取
  const candidate = extractOutermostBlock(raw);
  if (!candidate) {
    throw new JsonRepairExhaustedError("No JSON object {...} found", raw.slice(0, 200));
  }

  // 第 2 层: jsonrepair + JSON.parse + Zod
  let lastError: unknown;
  try {
    const repaired = repairJson(candidate);
    return TravelPlanSchema.parse(JSON.parse(repaired));
  } catch (err) {
    lastError = err;
  }

  // 第 3 层兜底: simpleRepair
  try {
    const repaired = simpleRepair(candidate);
    return TravelPlanSchema.parse(JSON.parse(repaired));
  } catch (err) {
    lastError = err;
  }

  throw new JsonRepairExhaustedError(
    `parsePlanLoose failed after extract + jsonrepair + simpleRepair`,
    candidate.slice(-300),
    lastError,
  );
}
