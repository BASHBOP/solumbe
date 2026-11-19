import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { ShipmentsService } from "./shipments.service";

@Controller("shipments")
export class ShipmentsController {
  constructor(private readonly shipments: ShipmentsService) {}

  @Post("free")
  createFreeShipment(@Body() body: { siteId: string; workerName: string }) {
    return this.shipments.createFreeShipment(body.siteId, body.workerName);
  }

  @Get(":id/slot-labels")
  slotLabels(@Param("id") id: string) {
    return this.shipments.slotLabelsForShipment(id);
  }
}
