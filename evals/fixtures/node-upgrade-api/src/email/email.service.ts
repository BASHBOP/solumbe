import sanitizeHtml from "sanitize-html";

export class EmailService {
  sanitizeBody(html: string): string {
    return sanitizeHtml(html, { allowedTags: ["b", "i", "a", "p"] });
  }
}
