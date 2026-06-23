import { z } from "zod";

export const VisitGuideSchema = z.object({
  entryGate: z.string().optional().describe("推荐入口/门"),
  recommendedRoute: z.string().optional().describe("推荐游览路线"),
  mustSeeItems: z.array(z.string()).max(10).optional().describe("必看项目/展品"),
  tips: z.array(z.string()).max(5).optional().describe("实用贴士"),
  isFullDay: z.boolean().optional().describe("是否需全天游览(6h+)"),
});

export type VisitGuide = z.infer<typeof VisitGuideSchema>;

export const ActivitySchema = z.object({
  name: z.string().min(1),
  category: z.enum(["attraction", "restaurant", "hotel", "shopping"]),
  location: z.object({
    lat: z.number(),
    lng: z.number(),
    address: z.string(),
  }).optional().default({ lat: 0, lng: 0, address: "" }),
  estimatedDurationMin: z.number().int().positive(),
  estimatedCost: z.number().nonnegative(),
  description: z.string().min(20).max(500),
  source: z.enum(["amap", "xhs", "rag", "baike", "llm_generated"]),
  rerankScore: z.number().min(0).max(1).optional().default(0.5),
  visitGuide: VisitGuideSchema.optional(),
});

export type PlanActivity = z.infer<typeof ActivitySchema>;
