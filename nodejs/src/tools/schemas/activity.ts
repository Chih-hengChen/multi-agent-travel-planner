import { z } from "zod";

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

export type PlanActivity = z.infer<typeof ActivitySchema>;
