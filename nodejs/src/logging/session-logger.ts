import fs from "node:fs";
import path from "node:path";
import { settings } from "../config/settings.js";

export type LogEventType =
  | "session_created"
  | "session_deleted"
  | "user_message"
  | "assistant_reply"
  | "state_change"
  | "transport_options"
  | "hotel_options"
  | "plan_result"
  | "plan_edited"
  | "select"
  | "info_extracted"
  | "llm_request"
  | "llm_response"
  | "agent_start"
  | "agent_done"
  | "tool_call"
  | "tool_result"
  | "source_call"
  | "source_result"
  | "error"
  | "route_decision"
  | "step_status"
  | "trace_event";

interface LogEntry {
  ts: string;
  sessionId: string;
  event: LogEventType;
  data: unknown;
}

const LOGS_DIR = path.resolve(process.cwd(), "logs");

function ensureLogsDir(): void {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

function toISO(): string {
  return new Date().toISOString();
}

export class SessionLogger {
  private streams = new Map<string, fs.WriteStream>();

  append(sessionId: string, event: LogEventType, data: unknown): void {
    if (settings.LOG_LEVEL === "silent") return;

    ensureLogsDir();
    const entry: LogEntry = { ts: toISO(), sessionId, event, data };
    const line = JSON.stringify(entry) + "\n";

    let stream = this.streams.get(sessionId);
    if (!stream || stream.destroyed) {
      const filePath = path.join(LOGS_DIR, `${sessionId}.jsonl`);
      stream = fs.createWriteStream(filePath, { flags: "a" });
      this.streams.set(sessionId, stream);
    }

    stream.write(line);
  }

  close(sessionId: string): void {
    const stream = this.streams.get(sessionId);
    if (stream && !stream.destroyed) {
      stream.end();
      this.streams.delete(sessionId);
    }
  }
}

export const sessionLogger = new SessionLogger();
