import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, renameSync } from "node:fs";
import { resolve, join } from "node:path";
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

export class FileSessionStore implements SessionStore {
  private readonly baseDir: string;
  private timer: ReturnType<typeof setInterval>;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    mkdirSync(baseDir, { recursive: true });
    this.timer = setInterval(() => this.sweep(), 60_000);
  }

  async get(sessionId: string): Promise<ConversationContext | null> {
    const filePath = this.filePath(sessionId);
    try {
      const raw = readFileSync(filePath, "utf-8");
      const entry: StoredEntry = JSON.parse(raw);
      if (Date.now() > entry.expiresAt) {
        this.safeUnlink(filePath);
        return null;
      }
      return structuredClone(entry.ctx);
    } catch {
      return null;
    }
  }

  async set(sessionId: string, ctx: ConversationContext): Promise<void> {
    const filePath = this.filePath(sessionId);
    try {
      const raw = readFileSync(filePath, "utf-8");
      const current: StoredEntry = JSON.parse(raw);
      if (current.ctx.version !== ctx.version - 1) {
        throw new VersionConflictError(
          sessionId,
          current.ctx.version + 1,
          ctx.version,
        );
      }
    } catch (err) {
      if (err instanceof VersionConflictError) throw err;
    }
    const entry: StoredEntry = {
      ctx: { ...ctx, updatedAt: Date.now() },
      expiresAt: Date.now() + settings.SESSION_TTL_MS,
    };
    const tmpPath = filePath + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(entry), "utf-8");
    renameSync(tmpPath, filePath);
  }

  async delete(sessionId: string): Promise<void> {
    this.safeUnlink(this.filePath(sessionId));
  }

  async refreshTtl(sessionId: string): Promise<void> {
    const filePath = this.filePath(sessionId);
    try {
      const raw = readFileSync(filePath, "utf-8");
      const entry: StoredEntry = JSON.parse(raw);
      entry.expiresAt = Date.now() + settings.SESSION_TTL_MS;
      const tmpPath = filePath + ".tmp";
      writeFileSync(tmpPath, JSON.stringify(entry), "utf-8");
      renameSync(tmpPath, filePath);
    } catch { /* session may not exist */ }
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private filePath(sessionId: string): string {
    return resolve(this.baseDir, `${sessionId}.json`);
  }

  private safeUnlink(filePath: string): void {
    try { unlinkSync(filePath); } catch { /* ignore ENOENT */ }
  }

  private sweep(): void {
    const now = Date.now();
    try {
      for (const file of readdirSync(this.baseDir)) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = readFileSync(join(this.baseDir, file), "utf-8");
          const entry: StoredEntry = JSON.parse(raw);
          if (now > entry.expiresAt) {
            this.safeUnlink(join(this.baseDir, file));
          }
        } catch { /* corrupted file, skip */ }
      }
    } catch { /* directory may not exist */ }
  }
}

export function createSessionStore(): SessionStore {
  if (settings.SESSION_STORE_TYPE === "file") {
    return new FileSessionStore(settings.SESSION_STORE_PATH || "./data/sessions");
  }
  return new MemorySessionStore();
}
