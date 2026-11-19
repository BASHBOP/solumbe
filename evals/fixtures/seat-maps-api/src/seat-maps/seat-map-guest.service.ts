import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { readStoredBuilder } from "./seat-map-builder.schema";
import { formatSeatPlace } from "./seat-place-text";
import { SeatPlaceNamer } from "./seat-places";

@Injectable()
export class SeatMapGuestService {
  constructor(private readonly prisma: PrismaService) {}

  async viewForGuest(eventId: string) {
    const map = await this.prisma.seatMap.findFirst({ where: { eventId } });
    const builder = readStoredBuilder(map.builder);
    return new SeatPlaceNamer(builder).places().map((place) => ({ label: formatSeatPlace(place), free: true }));
  }
}
