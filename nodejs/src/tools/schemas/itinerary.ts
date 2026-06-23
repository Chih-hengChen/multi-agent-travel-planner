import { z } from "zod";
import { ActivitySchema } from "./activity.js";
import { TransitSegmentSchema } from "./transit.js";

export const ItinerarySlotSchema = z.object({
  attractions: z.array(ActivitySchema).max(10),
  transitFromPrev: TransitSegmentSchema.optional().describe("到达本 slot 的交通(酒店→早间/上一 slot→本 slot)"),
  transitToNext: TransitSegmentSchema.optional().describe("离开本 slot 的交通(本 slot→下一 slot/晚间→酒店)"),
  notes: z.string().optional(),
});

export type PlanItinerarySlot = z.infer<typeof ItinerarySlotSchema>;
