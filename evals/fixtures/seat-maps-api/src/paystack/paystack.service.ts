import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class PaystackService {
  constructor(private readonly prisma: PrismaService) {}

  async startSeatMapPayment(bookingId: string, seatLabels: string[]) {
    const rows = seatLabels.map((label) => ({ label, block: "seat" }));
    return { bookingId, rows, start: Date.now() };
  }
}
