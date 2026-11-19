import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { SeatCheckoutService } from "./seat-checkout.service";
import { SeatLostRaceService } from "./seat-lost-race.service";
import { SeatMapCompGuestService } from "./seat-map-comp-guest.service";
import { SeatMapGuestService } from "./seat-map-guest.service";
import { SeatMapPublishService } from "./seat-map-publish.service";
import { SeatMapsController } from "./seat-maps.controller";

@Module({
  imports: [PrismaModule],
  controllers: [SeatMapsController],
  providers: [SeatMapPublishService, SeatMapGuestService, SeatMapCompGuestService, SeatCheckoutService, SeatLostRaceService],
})
export class SeatMapsModule {}
