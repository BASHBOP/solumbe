import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { PublishSeatMapDto } from "./dto/publish-seat-map.dto";
import { readStoredBuilder } from "./seat-map-builder.schema";
import { diffSeatRows } from "./seat-map-snapshot";
import { SeatPlaceNamer } from "./seat-places";

@Injectable()
export class SeatMapPublishService {
  constructor(private readonly prisma: PrismaService) {}

  async publish(eventId: string, dto: PublishSeatMapDto) {
    const builder = readStoredBuilder(dto.builder);
    const places = new SeatPlaceNamer(builder).places();
    const existing = await this.prisma.seat.findMany({ where: { seatMap: { eventId } } });
    return diffSeatRows(existing, places);
  }
}
