import { Body, Controller, Post } from "@nestjs/common";
import { CreateQuoteTemplateDto } from "./dto/create-quote-template.dto";
import { QuoteTemplatesService } from "./quote-templates.service";

@Controller("quote-templates")
export class QuoteTemplatesController {
  constructor(private readonly quoteTemplates: QuoteTemplatesService) {}

  @Post()
  createQuoteTemplate(@Body() dto: CreateQuoteTemplateDto) {
    return this.quoteTemplates.createQuoteTemplate(dto);
  }
}
