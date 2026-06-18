import { z } from "zod";

export const RestaurantSearchInputSchema = z.object({
  city: z.string().min(1),
  scope: z.enum(["city", "attraction"]).default("city"),
  near: z.string().optional(),
  mealType: z.enum(["breakfast", "lunch", "dinner", "any"]).default("any"),
  preference: z.enum(["local_specialties", "trending", "mixed"]).default("local_specialties"),
  maxResults: z.number().int().positive().default(8),
});

export type RestaurantSearchInput = z.infer<typeof RestaurantSearchInputSchema>;
