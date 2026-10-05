export function setupSessionCheck(onSessionError: (error: Error) => void) {
  return setInterval(async () => {
    const response = await fetch("/api/session");
    if (!response.ok) onSessionError(new Error("session expired"));
  }, 60_000);
}

export async function refreshSession() {
  return fetch("/api/session/refresh", { method: "POST" });
}
