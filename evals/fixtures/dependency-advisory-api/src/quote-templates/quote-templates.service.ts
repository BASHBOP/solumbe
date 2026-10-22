import { CreateQuoteTemplateDto } from "./dto/create-quote-template.dto";

export class QuoteTemplatesService {
  createQuoteTemplate(dto: CreateQuoteTemplateDto) {
    return { id: "quote-template", ...dto };
  }
}
