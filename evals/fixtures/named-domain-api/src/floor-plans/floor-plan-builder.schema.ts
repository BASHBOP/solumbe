import { z } from "zod";
import { ErrorCodes } from "../types/error.types";
import { MAX_SLOTS_PER_SITE, floorPlanLayoutSchema } from "./floor-plan-layout.schema";

const rowNumberingSchema = z.object({
  start: z.number().int().min(1).default(1),
  reverse: z.boolean().default(false),
});

const rowsBlockSchema = z.object({
  kind: z.literal("rows"),
  rows: z.number().int().positive(),
  slotsPerRow: z.number().int().positive(),
  numbering: rowNumberingSchema,
  slotLabels: z.enum(["numbers", "letters"]),
  rotation: z.number().default(0),
});

const fixtureBlockSchema = z.object({
  kind: z.literal("fixture"),
  shape: z.enum(["dock", "office", "packing-bench"]),
  label: z.string().max(40).optional(),
});

export const floorPlanBuilderSchema = z.object({
  layout: floorPlanLayoutSchema,
  blocks: z.array(z.union([rowsBlockSchema, fixtureBlockSchema])),
});

export type FloorPlanBuilder = z.infer<typeof floorPlanBuilderSchema>;

export function readStoredBuilder(stored: unknown): FloorPlanBuilder {
  const parsed = floorPlanBuilderSchema.safeParse(stored);
  if (!parsed.success) throw new Error(ErrorCodes.FloorPlanInvalid);
  if (countSlots(parsed.data) > MAX_SLOTS_PER_SITE) throw new Error(ErrorCodes.FloorPlanInvalid);
  return parsed.data;
}

function countSlots(builder: FloorPlanBuilder): number {
  return builder.blocks.reduce((total, block) => (block.kind === "rows" ? total + block.rows * block.slotsPerRow : total), 0);
}
