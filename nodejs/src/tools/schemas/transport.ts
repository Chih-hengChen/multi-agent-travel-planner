import { z } from "zod";

export const TransportOptionSchema = z.object({
  id: z.string(),
  type: z.enum(["flight", "train"]),
  departureCity: z.string(),
  arrivalCity: z.string(),
  departureTime: z.string(),
  arrivalTime: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  price: z.number().nonnegative(),
  currency: z.string().default("CNY"),
  airline: z.string().optional(),
  flightNo: z.string().optional(),
  trainNo: z.string().optional(),
  durationMin: z.number().positive().optional(),
});

export type TransportOption = z.infer<typeof TransportOptionSchema>;
