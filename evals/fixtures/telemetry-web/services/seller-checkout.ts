export async function createVendorSubscriptionCheckout(vendorId: string) {
  const session = await openCheckoutSession({ vendorId, mode: "subscription" });
  return session.url;
}

const completedSessions = new Set<string>();

export async function handleCheckoutSessionCompleted(sessionId: string) {
  const addOnIds = [...completedSessions];
  completedSessions.add(sessionId);
  return { sessionId, addOnIds, status: "complete" };
}

async function openCheckoutSession(input: { vendorId: string; mode: string }) {
  return { url: `/checkout/${input.vendorId}/${input.mode}` };
}
