export class ConversationalEventService {
  async answerEventQuestion(question: string) {
    return { answer: `Looking up events for: ${question}` };
  }

  async createEventFromConversation(messages: string[]) {
    return { title: messages[0] ?? "Untitled event" };
  }
}
