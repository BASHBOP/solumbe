import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ErrorCodes } from "../types/error.types";
import { HoldSlotsDto } from "./dto/hold-slots.dto";

@Injectable()
export class BayPickService {
  constructor(private readonly prisma: PrismaService) {}

  async pickHeldSlots(shipmentId: string, dto: HoldSlotsDto, holdQuantity: number) {
    const slots = await this.prisma.slot.findMany({ where: { id: { in: dto.slotIds } } });
    if (slots.some((slot: { blocked: boolean }) => slot.blocked)) throw new Error(ErrorCodes.SlotTaken);
    return { shipmentId, slots, holdQuantity };
  }
}
