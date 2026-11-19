import { FloorPlanBuilder } from "./floor-plan-builder.schema";

export interface Slot {
  blockIndex: number;
  rowLabel: string;
  slotLabel: string;
}

export class SlotNamer {
  constructor(private readonly builder: FloorPlanBuilder) {}

  slots(): Slot[] {
    const slots: Slot[] = [];
    this.builder.blocks.forEach((block, blockIndex) => {
      if (block.kind !== "rows") return;
      for (let row = 0; row < block.rows; row += 1) {
        const rowLabel = rowLabelFor(row, block.rows, block.numbering.start, block.numbering.reverse);
        for (let slot = 0; slot < block.slotsPerRow; slot += 1) {
          slots.push({ blockIndex, rowLabel, slotLabel: slotLabelFor(slot, block.slotLabels) });
        }
      }
    });
    return slots;
  }
}

function rowLabelFor(row: number, rows: number, start: number, reverse: boolean): string {
  return String(start + (reverse ? rows - 1 - row : row));
}

function slotLabelFor(slot: number, labels: "numbers" | "letters"): string {
  return labels === "letters" ? String.fromCharCode(65 + slot) : String(slot + 1);
}
