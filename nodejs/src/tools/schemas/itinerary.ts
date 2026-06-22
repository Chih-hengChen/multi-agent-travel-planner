import { z } from "zod";
import { ActivitySchema } from "./activity.js";
import { TransitSegmentSchema } from "./transit.js";

export const ItinerarySlotSchema = z.object({
  attractions: z.array(ActivitySchema).max(10),
  transitToNext: TransitSegmentSchema.optional(),
  notes: z.string().optional(),
});

export type PlanItinerarySlot = z.infer<typeof ItinerarySlotSchema>;
