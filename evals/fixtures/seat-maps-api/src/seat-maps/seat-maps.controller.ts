import { Body, Controller, Param, Post } from "@nestjs/common";
import { CompSeatsDto } from "./dto/comp-seats.dto";
import { HoldPlacesDto } from "./dto/hold-places.dto";
import { PublishSeatMapDto } from "./dto/publish-seat-map.dto";
import { SeatCheckoutService } from "./seat-checkout.service";
import { SeatMapCompGuestService } from "./seat-map-comp-guest.service";
import { SeatMapPublishService } from "./seat-map-publish.service";

@Controller("events/:eventId/seat-map")
export class SeatMapsController {
  constructor(
    private readonly publishService: SeatMapPublishService,
    private readonly compGuest: SeatMapCompGuestService,
    private readonly checkout: SeatCheckoutService,
  ) {}

  @Post("publish")
  publish(@Param("eventId") eventId: string, @Body() dto: PublishSeatMapDto) {
    return this.publishService.publish(eventId, dto);
  }

  @Post("comps")
  comp(@Param("eventId") eventId: string, @Body() dto: CompSeatsDto) {
    return this.compGuest.compPlaceForNamedGuest(eventId, dto);
  }

  @Post("checkout")
  hold(@Param("eventId") eventId: string, @Body() dto: HoldPlacesDto) {
    return this.checkout.checkoutHeldSeats(eventId, dto, 0);
  }
}
