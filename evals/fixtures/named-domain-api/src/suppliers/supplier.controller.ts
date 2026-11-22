import { Controller, Get, Param } from "@nestjs/common";
import { ShipmentsService } from "../shipments/shipments.service";

@Controller("suppliers")
export class SupplierController {
  constructor(private readonly shipments: ShipmentsService) {}

  @Get(":shipmentId/floor-plan-labels")
  floorPlanLabels(@Param("shipmentId") shipmentId: string) {
    return this.shipments.slotLabelsForShipment(shipmentId);
  }
}
