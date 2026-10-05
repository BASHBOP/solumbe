export function emitOpenPanelEvent(eventName: string, params: Record<string, unknown>) {
  window.op?.("track", eventName, params);
}

export function trackCustomEvent(eventName: string, params: Record<string, unknown>) {
  emitOpenPanelEvent(eventName, params);
}

export function trackPageView(pagePath: string) {
  trackCustomEvent("page_view", { page_path: pagePath });
}
