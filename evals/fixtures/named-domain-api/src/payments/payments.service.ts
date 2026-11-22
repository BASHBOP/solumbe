import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class PaymentsService {
  constructor(private readonly prisma: PrismaService) {}

  async startFloorPlanPayment(shipmentId: string, slotLabels: string[]) {
    const rows = slotLabels.map((label) => ({ label, block: "slot" }));
    return { shipmentId, rows, start: Date.now() };
  }
}
