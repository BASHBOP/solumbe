import { SeatPlace } from "./seat-places";

export interface TogetherBlock {
  blockIndex: number;
  rows: SeatPlace[][];
}

export function pickSeatsTogether(blocks: TogetherBlock[], count: number): SeatPlace[] {
  for (const block of blocks) {
    for (const row of block.rows) {
      for (let start = 0; start + count <= row.length; start += 1) {
        return row.slice(start, start + count);
      }
    }
  }
  return [];
}
