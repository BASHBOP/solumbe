import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { BookingService } from "./booking.service";

@Controller("bookings")
export class BookingController {
  constructor(private readonly bookings: BookingService) {}

  @Post("free")
  createFreeBooking(@Body() body: { eventId: string; guestName: string }) {
    return this.bookings.createFreeBooking(body.eventId, body.guestName);
  }

  @Get(":id/seat-labels")
  seatLabels(@Param("id") id: string) {
    return this.bookings.seatLabelsForBooking(id);
  }
}
