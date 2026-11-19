import { Slot } from "./slot-names";

export function formatSlot(slot: Slot): string {
  return `Row ${slot.rowLabel}, slot ${slot.slotLabel}`;
}

export function slotLines(slots: Slot[]): string[] {
  return slots.map(formatSlot);
}
