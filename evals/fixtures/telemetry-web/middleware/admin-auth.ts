const sessions = new Map<string, { userId: string; expiresAt: number }>();

export function createSession(userId: string) {
  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, { userId, expiresAt: Date.now() + 3600_000 });
  return sessionId;
}

export function removeSession(sessionId: string) {
  sessions.delete(sessionId);
}

export function validateSession(sessionId: string) {
  const session = sessions.get(sessionId);
  return Boolean(session && session.expiresAt > Date.now());
}
