import { z } from "zod";

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

export type PlanTransitSegment = z.infer<typeof TransitSegmentSchema>;
