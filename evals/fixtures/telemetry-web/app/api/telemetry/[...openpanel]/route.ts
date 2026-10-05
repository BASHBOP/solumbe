import { createRouteHandler } from "@openpanel/nextjs/server";

const openPanelHandler = createRouteHandler({ apiUrl: "https://openpanel.example.com" });

export const GET = openPanelHandler.GET;
export const POST = openPanelHandler.POST;
