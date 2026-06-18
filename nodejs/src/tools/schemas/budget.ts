import { z } from "zod";

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

export type PlanBudgetBreakdown = z.infer<typeof BudgetBreakdownSchema>;
