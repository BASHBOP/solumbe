import { z } from "zod";

export const MAX_PLACES_PER_EVENT = 5000;

export const seatMapLayoutSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  rotation: z.number().min(0).max(359).default(0),
});

export type SeatMapLayout = z.infer<typeof seatMapLayoutSchema>;
