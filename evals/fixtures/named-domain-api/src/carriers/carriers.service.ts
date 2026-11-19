import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class CarriersService {
  constructor(private readonly prisma: PrismaService) {}

  async floorPlanLoads(siteId: string, slotLabels: string[]) {
    const rows = await this.prisma.shipment.findMany({ where: { siteId } });
    const labels = slotLabels.map((label) => ({ label, block: "slot" }));
    return { rows, labels, start: rows.length, block: "floor plan loads" };
  }
}
