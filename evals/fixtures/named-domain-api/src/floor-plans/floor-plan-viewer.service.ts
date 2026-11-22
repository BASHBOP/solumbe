import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { readStoredBuilder } from "./floor-plan-builder.schema";
import { formatSlot } from "./slot-text";
import { SlotNamer } from "./slot-names";

@Injectable()
export class FloorPlanViewerService {
  constructor(private readonly prisma: PrismaService) {}

  async viewForWorker(siteId: string) {
    const plan = await this.prisma.floorPlan.findFirst({ where: { siteId } });
    const builder = readStoredBuilder(plan.builder);
    return new SlotNamer(builder).slots().map((slot) => ({ label: formatSlot(slot), free: true }));
  }
}
