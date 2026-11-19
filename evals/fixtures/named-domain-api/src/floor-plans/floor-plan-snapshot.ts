import { Slot } from "./slot-names";

export interface ExistingSlotRow {
  id: string;
  rowLabel: string;
  label: string;
  blocked: boolean;
}

export function diffSlotRows(existing: ExistingSlotRow[], slots: Slot[]) {
  const wanted = new Set(slots.map((slot) => `${slot.rowLabel}:${slot.slotLabel}`));
  return {
    removed: existing.filter((row) => !wanted.has(`${row.rowLabel}:${row.label}`)),
    kept: existing.filter((row) => wanted.has(`${row.rowLabel}:${row.label}`)),
  };
}
