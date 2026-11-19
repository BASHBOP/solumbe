import { z } from "zod";

export const MAX_SLOTS_PER_SITE = 5000;

export const floorPlanLayoutSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  rotation: z.number().min(0).max(359).default(0),
});

export type FloorPlanLayout = z.infer<typeof floorPlanLayoutSchema>;
