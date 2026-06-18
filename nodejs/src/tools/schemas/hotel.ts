import { z } from "zod";

export const GeoConstraintSchema = z.object({
  maxDistanceKm: z.number().positive().default(5),
  preferNear: z.enum(["transit", "center"]).optional(),
});

export const HotelSearchInputSchema = z.object({
  city: z.string().min(1),
  checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  adults: z.number().int().positive().default(1),
  maxPricePerNight: z.number().positive().optional(),
  maxStarRating: z.number().int().min(1).max(5).optional(),
  preferredArea: z.string().optional(),
  keyAttractions: z.array(z.string()).optional(),
  geoConstraint: GeoConstraintSchema.optional(),
  preferredBrands: z.array(z.string()).optional(),
});

export type GeoConstraint = z.infer<typeof GeoConstraintSchema>;
export type HotelSearchInput = z.infer<typeof HotelSearchInputSchema>;
