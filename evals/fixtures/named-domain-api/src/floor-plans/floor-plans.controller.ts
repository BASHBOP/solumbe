import { Body, Controller, Param, Post } from "@nestjs/common";
import { AssignSlotsDto } from "./dto/assign-slots.dto";
import { HoldSlotsDto } from "./dto/hold-slots.dto";
import { PublishFloorPlanDto } from "./dto/publish-floor-plan.dto";
import { FloorPlanAssignWorkerService } from "./floor-plan-assign-worker.service";
import { FloorPlanPublishService } from "./floor-plan-publish.service";
import { BayPickService } from "./bay-pick.service";

@Controller("sites/:siteId/floor-plan")
export class FloorPlansController {
  constructor(
    private readonly publishService: FloorPlanPublishService,
    private readonly assignWorker: FloorPlanAssignWorkerService,
    private readonly pick: BayPickService,
  ) {}

  @Post("publish")
  publish(@Param("siteId") siteId: string, @Body() dto: PublishFloorPlanDto) {
    return this.publishService.publish(siteId, dto);
  }

  @Post("assignments")
  assign(@Param("siteId") siteId: string, @Body() dto: AssignSlotsDto) {
    return this.assignWorker.assignSlotToNamedWorker(siteId, dto);
  }

  @Post("hold")
  hold(@Param("siteId") siteId: string, @Body() dto: HoldSlotsDto) {
    return this.pick.pickHeldSlots(siteId, dto, 0);
  }
}
