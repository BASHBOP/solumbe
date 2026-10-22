import { ConversationalEventService } from "../services/conversational-event.service";

export class EventAssistantController {
  constructor(private readonly assistant: ConversationalEventService) {}

  async ask(question: string) {
    return this.assistant.answerEventQuestion(question);
  }
}
