import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ErrorCodes } from "../types/error.types";
import { HoldPlacesDto } from "./dto/hold-places.dto";

@Injectable()
export class SeatCheckoutService {
  constructor(private readonly prisma: PrismaService) {}

  async checkoutHeldSeats(bookingId: string, dto: HoldPlacesDto, holdPrice: number) {
    const seats = await this.prisma.seat.findMany({ where: { id: { in: dto.seatIds } } });
    if (seats.some((seat: { blocked: boolean }) => seat.blocked)) throw new Error(ErrorCodes.SeatTaken);
    return { bookingId, seats, holdPrice };
  }
}
