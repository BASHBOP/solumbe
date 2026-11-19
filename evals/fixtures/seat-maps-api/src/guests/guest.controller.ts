import { Controller, Get, Param } from "@nestjs/common";
import { BookingService } from "../booking/booking.service";

@Controller("guests")
export class GuestController {
  constructor(private readonly bookings: BookingService) {}

  @Get(":bookingId/seat-map-labels")
  seatMapLabels(@Param("bookingId") bookingId: string) {
    return this.bookings.seatLabelsForBooking(bookingId);
  }
}
