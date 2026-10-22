import { formatTicketQuote } from "../utils/format";

export function TicketScreen({ amount }: { amount: number }) {
  return formatTicketQuote(amount);
}
