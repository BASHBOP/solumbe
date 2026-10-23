export function SubscriptionGate({ tier, children }: { tier: string; children: React.ReactNode }) {
  if (tier === "free") return <p>Upgrade to unlock this feature.</p>;
  return <>{children}</>;
}
