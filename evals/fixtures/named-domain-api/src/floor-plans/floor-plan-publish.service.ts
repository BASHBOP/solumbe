import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { PublishFloorPlanDto } from "./dto/publish-floor-plan.dto";
import { readStoredBuilder } from "./floor-plan-builder.schema";
import { diffSlotRows } from "./floor-plan-snapshot";
import { SlotNamer } from "./slot-names";

@Injectable()
export class FloorPlanPublishService {
  constructor(private readonly prisma: PrismaService) {}

  async publish(siteId: string, dto: PublishFloorPlanDto) {
    const builder = readStoredBuilder(dto.builder);
    const slots = new SlotNamer(builder).slots();
    const existing = await this.prisma.slot.findMany({ where: { floorPlan: { siteId } } });
    return diffSlotRows(existing, slots);
  }
}
