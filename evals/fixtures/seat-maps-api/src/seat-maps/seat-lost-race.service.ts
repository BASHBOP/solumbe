import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class SeatLostRaceService {
  constructor(private readonly prisma: PrismaService) {}

  // A late payment for a seat someone else took: the seat is lost, so refund it.
  async refundLatePayment(bookingId: string) {
    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId } });
    return { booking, refund: "pending" };
  }

  async retryFailedRefund(bookingId: string) {
    return { bookingId, recovery: "retry", failed: false };
  }
}
