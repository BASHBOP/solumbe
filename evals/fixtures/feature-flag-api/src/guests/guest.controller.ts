export class GuestController {
  async rsvp(eventId: string, guestId: string) {
    return { eventId, guestId, status: "going" };
  }
}
