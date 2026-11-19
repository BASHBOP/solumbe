import { Injectable } from "@nestjs/common";

@Injectable()
export class EmailService {
  async sendSeatMapTicket(guestName: string, seatLabels: string[]) {
    const rows = seatLabels.map((label) => `<tr><td>${label}</td></tr>`);
    return { to: guestName, block: rows.join(""), start: "Your seat map places" };
  }
}
