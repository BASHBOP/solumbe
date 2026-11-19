import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { FloorPlanAssignWorkerService } from "./floor-plan-assign-worker.service";
import { FloorPlanPublishService } from "./floor-plan-publish.service";
import { FloorPlanViewerService } from "./floor-plan-viewer.service";
import { FloorPlansController } from "./floor-plans.controller";
import { BayLostRaceService } from "./bay-lost-race.service";
import { BayPickService } from "./bay-pick.service";

@Module({
  imports: [PrismaModule],
  controllers: [FloorPlansController],
  providers: [FloorPlanPublishService, FloorPlanViewerService, FloorPlanAssignWorkerService, BayPickService, BayLostRaceService],
})
export class FloorPlansModule {}
