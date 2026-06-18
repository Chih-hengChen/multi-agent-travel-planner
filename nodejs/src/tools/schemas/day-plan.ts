import { z } from "zod";
import { ItinerarySlotSchema } from "./itinerary.js";
import { DiningPlanSchema } from "./dining.js";

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

export type PlanDayPlan = z.infer<typeof DayPlanSchema>;
