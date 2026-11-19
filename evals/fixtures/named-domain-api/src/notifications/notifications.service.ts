import { Injectable } from "@nestjs/common";

@Injectable()
export class NotificationsService {
  async sendFloorPlanNotice(workerName: string, slotLabels: string[]) {
    const rows = slotLabels.map((label) => ({ label, block: `<tr><td>${label}</td></tr>` }));
    return { to: workerName, rows, block: rows.map((row) => row.block).join(""), start: "Your floor plan slots" };
  }
}
