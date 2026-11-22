import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ErrorCodes } from "../types/error.types";
import { AssignSlotsDto } from "./dto/assign-slots.dto";

@Injectable()
export class FloorPlanAssignWorkerService {
  constructor(private readonly prisma: PrismaService) {}

  // The supervisor gives a free slot to a named worker: an internal shipment.
  async assignSlotToNamedWorker(siteId: string, dto: AssignSlotsDto) {
    const slots = await this.prisma.slot.findMany({ where: { id: { in: dto.slotIds } } });
    if (slots.length !== dto.slotIds.length) throw new Error(ErrorCodes.SlotTaken);
    return this.prisma.shipment.create({ data: { siteId, status: "INTERNAL", workerName: dto.workerName } });
  }
}
