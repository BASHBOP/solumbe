import { SeatMapBuilder } from "./seat-map-builder.schema";

export interface SeatPlace {
  blockIndex: number;
  rowLabel: string;
  seatLabel: string;
}

export class SeatPlaceNamer {
  constructor(private readonly builder: SeatMapBuilder) {}

  places(): SeatPlace[] {
    const places: SeatPlace[] = [];
    this.builder.blocks.forEach((block, blockIndex) => {
      if (block.kind !== "rows") return;
      for (let row = 0; row < block.rows; row += 1) {
        const rowLabel = rowLabelFor(row, block.rows, block.numbering.start, block.numbering.reverse);
        for (let seat = 0; seat < block.seatsPerRow; seat += 1) {
          places.push({ blockIndex, rowLabel, seatLabel: seatLabelFor(seat, block.seatLabels) });
        }
      }
    });
    return places;
  }
}

function rowLabelFor(row: number, rows: number, start: number, reverse: boolean): string {
  return String(start + (reverse ? rows - 1 - row : row));
}

function seatLabelFor(seat: number, labels: "numbers" | "letters"): string {
  return labels === "letters" ? String.fromCharCode(65 + seat) : String(seat + 1);
}
