import { Slot } from "./slot-names";

export interface TogetherBlock {
  blockIndex: number;
  rows: Slot[][];
}

export function pickSlotsTogether(blocks: TogetherBlock[], count: number): Slot[] {
  for (const block of blocks) {
    for (const row of block.rows) {
      for (let start = 0; start + count <= row.length; start += 1) {
        return row.slice(start, start + count);
      }
    }
  }
  return [];
}
