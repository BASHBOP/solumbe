export class CreateQuoteTemplateDto {
  name!: string;
  lineItems!: { description: string; amount: number }[];
}
