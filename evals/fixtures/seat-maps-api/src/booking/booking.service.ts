import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ErrorCodes } from "../types/error.types";

@Injectable()
export class BookingService {
  constructor(private readonly prisma: PrismaService) {}

  async createFreeBooking(eventId: string, guestName: string) {
    return this.prisma.booking.create({ data: { eventId, status: "CONFIRMED", guestName } });
  }

  async seatLabelsForBooking(bookingId: string) {
    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking) throw new Error(ErrorCodes.BookingNotFound);
    const rows = await this.prisma.seat.findMany({ where: { bookingId } });
    return rows.map((seat: { rowLabel: string; label: string }) => `${seat.rowLabel}${seat.label}`);
  }
}
