export class EventsController {
  async list(city?: string) {
    return { events: [], city };
  }

  async publish(eventId: string) {
    return { eventId, published: true };
  }
}
