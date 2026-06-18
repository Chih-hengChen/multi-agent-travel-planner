import { z } from "zod";
import { DayPlanSchema } from "./day-plan.js";
import { BudgetBreakdownSchema } from "./budget.js";

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
