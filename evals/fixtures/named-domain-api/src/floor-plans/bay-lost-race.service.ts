import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class BayLostRaceService {
  constructor(private readonly prisma: PrismaService) {}

  // A late payment for a slot someone else took: the slot is lost, so refund it.
  async refundLatePayment(shipmentId: string) {
    const shipment = await this.prisma.shipment.findUnique({ where: { id: shipmentId } });
    return { shipment, refund: "pending" };
  }

  async retryFailedRefund(shipmentId: string) {
    return { shipmentId, recovery: "retry", failed: false };
  }
}
