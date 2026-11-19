import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ErrorCodes } from "../types/error.types";
import { CompSeatsDto } from "./dto/comp-seats.dto";

@Injectable()
export class SeatMapCompGuestService {
  constructor(private readonly prisma: PrismaService) {}

  // The organiser gives a free place to a named guest: a comp booking.
  async compPlaceForNamedGuest(eventId: string, dto: CompSeatsDto) {
    const seats = await this.prisma.seat.findMany({ where: { id: { in: dto.seatIds } } });
    if (seats.length !== dto.seatIds.length) throw new Error(ErrorCodes.SeatTaken);
    return this.prisma.booking.create({ data: { eventId, status: "COMP", guestName: dto.guestName } });
  }
}
