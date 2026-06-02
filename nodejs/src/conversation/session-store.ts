import type { ConversationContext } from "./context.js";
import { settings } from "../config/settings.js";

export interface SessionStore {
  get(sessionId: string): Promise<ConversationContext | null>;
  set(sessionId: string, ctx: ConversationContext): Promise<void>;
  delete(sessionId: string): Promise<void>;
  refreshTtl(sessionId: string): Promise<void>;
}

export class VersionConflictError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly expectedVersion: number,
    public readonly actualVersion: number,
  ) {
    super(
      `Version conflict for session ${sessionId}: expected ${expectedVersion}, got ${actualVersion}`,
    );
    this.name = "VersionConflictError";
  }
}

interface StoredEntry {
  ctx: ConversationContext;
  expiresAt: number;
}

export class MemorySessionStore implements SessionStore {
  private store = new Map<string, StoredEntry>();
  private timer: ReturnType<typeof setInterval>;

  constructor() {
    this.timer = setInterval(() => this.sweep(), 60_000);
  }

  async get(sessionId: string): Promise<ConversationContext | null> {
    const entry = this.store.get(sessionId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(sessionId);
      return null;
    }
    return structuredClone(entry.ctx);
  }

  async set(sessionId: string, ctx: ConversationContext): Promise<void> {
    const current = this.store.get(sessionId);
    if (current && current.ctx.version !== ctx.version - 1) {
      throw new VersionConflictError(
        sessionId,
        current.ctx.version + 1,
        ctx.version,
      );
    }
    this.store.set(sessionId, {
      ctx: { ...ctx, updatedAt: Date.now() },
      expiresAt: Date.now() + settings.SESSION_TTL_MS,
    });
  }

  async delete(sessionId: string): Promise<void> {
    this.store.delete(sessionId);
  }

  async refreshTtl(sessionId: string): Promise<void> {
    const entry = this.store.get(sessionId);
    if (!entry) return;
    entry.expiresAt = Date.now() + settings.SESSION_TTL_MS;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  stop(): void {
    clearInterval(this.timer);
  }
}

export function createSessionStore(): MemorySessionStore {
  return new MemorySessionStore();
}
