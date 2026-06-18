import { z } from "zod";

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

export const ActivitySchema = z.object({
  name: z.string().min(1),
  category: z.enum(["attraction", "restaurant", "hotel", "shopping"]),
  location: z.object({
    lat: z.number(),
    lng: z.number(),
    address: z.string(),
  }),
  estimatedDurationMin: z.number().int().positive(),
  estimatedCost: z.number().nonnegative(),
  description: z.string().min(20).max(500),
  source: z.enum(["amap", "xhs", "rag", "baike", "llm_generated"]),
  rerankScore: z.number().min(0).max(1),
});

export const TransitSegmentSchema = z.object({
  from: z.string(),
  to: z.string(),
  mode: z.enum(["transit", "walking", "driving", "rideshare"]),
  durationMin: z.number().positive(),
  distanceKm: z.number().nonnegative(),
  cost: z.string(),
  costAmount: z.number(),
  steps: z.array(z.string()),
  fallbackLevel: z.union([z.literal(0), z.literal(1), z.literal(2)]),
});

export const DiningPlanSchema = z.object({
  meal: z.enum(["breakfast", "lunch", "dinner"]),
  restaurant: ActivitySchema.optional(),
  alternatives: z.array(z.string()).max(3).optional(),
  isLocalSpecialty: z.boolean(),
});

export const ItinerarySlotSchema = z.object({
  attractions: z.array(ActivitySchema).min(1).max(3),
  transitToNext: TransitSegmentSchema.optional(),
  notes: z.string().optional(),
});

export const DayPlanSchema = z.object({
  dayIdx: z.number().int().nonnegative(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  theme: z.string().optional(),
  morning: ItinerarySlotSchema.optional(),
  afternoon: ItinerarySlotSchema.optional(),
  evening: ItinerarySlotSchema.optional(),
  dining: z.array(DiningPlanSchema).length(3),
  transitTips: z.array(z.string()),
});

export const BudgetBreakdownSchema = z.object({
  totalCost: z.number().nonnegative(),
  byCategory: z.object({
    transport: z.number().nonnegative(),
    accommodation: z.number().nonnegative(),
    food: z.number().nonnegative(),
    attractions: z.number().nonnegative(),
    other: z.number().nonnegative(),
  }),
  budgetLimit: z.number().positive(),
  isWithinBudget: z.boolean(),
  variance: z.number(),
  suggestions: z.array(z.string()).optional(),
});

export const TravelPlanSchema = z.object({
  destination: z.string(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  travelers: z.number().int().positive(),
  dayPlans: z.array(DayPlanSchema),
  budgetBreakdown: BudgetBreakdownSchema,
  warnings: z.array(z.string()),
});

export type TravelPlan = z.infer<typeof TravelPlanSchema>;
export type PlanActivity = z.infer<typeof ActivitySchema>;
export type PlanTransitSegment = z.infer<typeof TransitSegmentSchema>;
export type PlanDayPlan = z.infer<typeof DayPlanSchema>;
export type PlanBudgetBreakdown = z.infer<typeof BudgetBreakdownSchema>;
export type PlanDiningPlan = z.infer<typeof DiningPlanSchema>;
export type PlanItinerarySlot = z.infer<typeof ItinerarySlotSchema>;

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

export function parsePlanLoose(raw: string): TravelPlan {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new JsonRepairExhaustedError("Empty input", raw?.slice(0, 200) ?? "");
  }

  const candidate = extractOutermostBlock(raw);
  if (!candidate) {
    throw new JsonRepairExhaustedError("No JSON object {...} found", raw.slice(0, 200));
  }

  let lastError: unknown;
  try {
    return TravelPlanSchema.parse(JSON.parse(candidate));
  } catch (err) {
    lastError = err;
  }

  try {
    const repaired = simpleRepair(candidate);
    return TravelPlanSchema.parse(JSON.parse(repaired));
  } catch (err) {
    lastError = err;
  }

  throw new JsonRepairExhaustedError(
    `parsePlanLoose failed after regex + simpleRepair`,
    candidate.slice(-300),
    lastError,
  );
}
