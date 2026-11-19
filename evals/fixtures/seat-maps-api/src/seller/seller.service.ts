import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class SellerService {
  constructor(private readonly prisma: PrismaService) {}

  async seatMapSales(eventId: string) {
    const rows = await this.prisma.booking.findMany({ where: { eventId } });
    return { rows, start: rows.length, block: "seat map sales" };
  }
}
