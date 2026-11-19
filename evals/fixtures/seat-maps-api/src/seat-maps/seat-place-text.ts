import { SeatPlace } from "./seat-places";

export function formatSeatPlace(place: SeatPlace): string {
  return `Row ${place.rowLabel}, seat ${place.seatLabel}`;
}

export function seatPlaceLines(places: SeatPlace[]): string[] {
  return places.map(formatSeatPlace);
}
