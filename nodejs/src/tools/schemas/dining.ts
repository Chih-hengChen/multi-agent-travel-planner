import { z } from "zod";
import { ActivitySchema } from "./activity.js";

export const DiningPlanSchema = z.object({
  meal: z.enum(["breakfast", "lunch", "dinner"]),
  restaurant: ActivitySchema.optional(),
  alternatives: z.array(z.string()).max(3).optional(),
  isLocalSpecialty: z.boolean(),
});

export type PlanDiningPlan = z.infer<typeof DiningPlanSchema>;
