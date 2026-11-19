import { SeatPlace } from "./seat-places";

export interface ExistingSeatRow {
  id: string;
  rowLabel: string;
  label: string;
  blocked: boolean;
}

export function diffSeatRows(existing: ExistingSeatRow[], places: SeatPlace[]) {
  const wanted = new Set(places.map((place) => `${place.rowLabel}:${place.seatLabel}`));
  return {
    removed: existing.filter((row) => !wanted.has(`${row.rowLabel}:${row.label}`)),
    kept: existing.filter((row) => wanted.has(`${row.rowLabel}:${row.label}`)),
  };
}
