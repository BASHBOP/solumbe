import { OpenPanelComponent } from "@openpanel/nextjs";

export function hasAnalyticsConsent(): boolean {
  const stored = window.localStorage.getItem("cookieConsentGiven");
  return Boolean(stored && JSON.parse(stored).analytics);
}

export function OpenPanelProvider() {
  if (!hasAnalyticsConsent()) return null;
  return <OpenPanelComponent clientId="client" apiUrl="/api/telemetry" trackScreenViews />;
}
