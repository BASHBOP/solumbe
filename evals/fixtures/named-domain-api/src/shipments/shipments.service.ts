import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ErrorCodes } from "../types/error.types";

@Injectable()
export class ShipmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async createFreeShipment(siteId: string, workerName: string) {
    return this.prisma.shipment.create({ data: { siteId, status: "CONFIRMED", workerName } });
  }

  async slotLabelsForShipment(shipmentId: string) {
    const shipment = await this.prisma.shipment.findUnique({ where: { id: shipmentId } });
    if (!shipment) throw new Error(ErrorCodes.ShipmentNotFound);
    const rows = await this.prisma.slot.findMany({ where: { shipmentId } });
    return rows.map((slot: { rowLabel: string; label: string }) => `${slot.rowLabel}${slot.label}`);
  }
}
