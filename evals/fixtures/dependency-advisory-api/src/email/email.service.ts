import { MailerService } from "@nestjs-modules/mailer";

export class EmailService {
  constructor(private readonly mailer: MailerService) {}

  sendBookingConfirmation(to: string, context: Record<string, unknown>) {
    return this.mailer.sendMail({ to, template: "booking-confirmation", context });
  }
}
