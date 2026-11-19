import { z } from "zod";
import { ErrorCodes } from "../types/error.types";
import { MAX_PLACES_PER_EVENT, seatMapLayoutSchema } from "./seat-map-layout.schema";

const rowNumberingSchema = z.object({
  start: z.number().int().min(1).default(1),
  reverse: z.boolean().default(false),
});

const rowsBlockSchema = z.object({
  kind: z.literal("rows"),
  rows: z.number().int().positive(),
  seatsPerRow: z.number().int().positive(),
  numbering: rowNumberingSchema,
  seatLabels: z.enum(["numbers", "letters"]),
  rotation: z.number().default(0),
});

const decorBlockSchema = z.object({
  kind: z.literal("decor"),
  shape: z.enum(["stage", "bar", "dancefloor"]),
  label: z.string().max(40).optional(),
});

export const seatMapBuilderSchema = z.object({
  layout: seatMapLayoutSchema,
  blocks: z.array(z.union([rowsBlockSchema, decorBlockSchema])),
});

export type SeatMapBuilder = z.infer<typeof seatMapBuilderSchema>;

export function readStoredBuilder(stored: unknown): SeatMapBuilder {
  const parsed = seatMapBuilderSchema.safeParse(stored);
  if (!parsed.success) throw new Error(ErrorCodes.SeatMapInvalid);
  if (countPlaces(parsed.data) > MAX_PLACES_PER_EVENT) throw new Error(ErrorCodes.SeatMapInvalid);
  return parsed.data;
}

function countPlaces(builder: SeatMapBuilder): number {
  return builder.blocks.reduce((total, block) => (block.kind === "rows" ? total + block.rows * block.seatsPerRow : total), 0);
}
