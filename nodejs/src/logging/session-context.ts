import { AsyncLocalStorage } from "node:async_hooks";
import { sessionLogger, type LogEventType } from "./session-logger.js";

const sessionAls = new AsyncLocalStorage<string>();

export function withSessionId<T>(sessionId: string, fn: () => T): T {
  return sessionAls.run(sessionId, fn);
}

export function getSessionId(): string | undefined {
  return sessionAls.getStore();
}

export function logWithSession(event: LogEventType, data: unknown): void {
  const sid = getSessionId();
  if (sid) {
    sessionLogger.append(sid, event, data);
  }
}
