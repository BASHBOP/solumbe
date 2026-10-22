import { ConversationalEventService } from "../services/conversational-event.service";

export class MascotAssistantController {
  constructor(private readonly assistant: ConversationalEventService) {}

  async chat(message: string) {
    return this.assistant.answerEventQuestion(message);
  }
}
