import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type TraceEvent,
  parseThought,
  trace,
  traceNow,
  makeTraceEvent,
  traceFilePath,
  setTraceDir,
  getTraceDir,
} from "../trace.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "trace-test-"));
  setTraceDir(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function readTraceLines(sid: string): TraceEvent[] {
  const path = traceFilePath(sid);
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf8");
  return content.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as TraceEvent);
}

describe("parseThought", () => {
  it("returns empty string for undefined input", () => {
    expect(parseThought(undefined)).toBe("");
  });

  it("returns empty string for null input", () => {
    expect(parseThought(null)).toBe("");
  });

  it("returns empty string for empty string", () => {
    expect(parseThought("")).toBe("");
  });

  it("returns empty string when no <thought> tag present", () => {
    expect(parseThought("just some text without tags")).toBe("");
  });

  it("extracts single-line thought content", () => {
    expect(parseThought("<thought>do the thing</thought>")).toBe("do the thing");
  });

  it("extracts multi-line thought and trims whitespace", () => {
    const text = `<thought>
      phase=searching, 已有目的地东京。
      下一步并行调用 4 个搜索工具。
    </thought>`;
    const result = parseThought(text);
    expect(result).toContain("phase=searching");
    expect(result).toContain("下一步");
    expect(result.startsWith("\n")).toBe(false);
    expect(result.endsWith("\n")).toBe(false);
  });

  it("extracts only first thought when multiple present", () => {
    const text = "<thought>first</thought> middle <thought>second</thought>";
    expect(parseThought(text)).toBe("first");
  });

  it("is case-sensitive (uppercase THOUGHT not matched)", () => {
    expect(parseThought("<THOUGHT>nope</THOUGHT>")).toBe("");
  });

  it("handles text around thought tag", () => {
    const text = "Before. <thought>actual</thought> After.";
    expect(parseThought(text)).toBe("actual");
  });

  it("handles nested-style content (lazy match)", () => {
    const text = "<thought>outer <thought>inner</thought> still outer</thought>";
    expect(parseThought(text)).toBe("outer <thought>inner");
  });

  it("returns empty for unclosed thought tag", () => {
    expect(parseThought("<thought>never closed")).toBe("");
  });

  it("returns empty for unopened thought tag", () => {
    expect(parseThought("never opened</thought>")).toBe("");
  });
});

describe("trace file writing", () => {
  it("creates file on first write (auto mkdir recursive)", () => {
    const event = traceNow("test-sid-001", 0, {
      type: "llm_request",
      phase: "gathering",
      model: "glm-4.7",
      tools: ["collect_preferences"],
    });
    expect(existsSync(traceFilePath("test-sid-001"))).toBe(true);
    expect(event.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(event.sid).toBe("test-sid-001");
    expect(event.iter).toBe(0);
  });

  it("appends second event as new line (one JSON per line)", () => {
    traceNow("test-sid-002", 0, {
      type: "llm_request",
      phase: "gathering",
      model: "glm-4.7",
      tools: ["t1"],
    });
    traceNow("test-sid-002", 1, {
      type: "llm_response",
      stopReason: "tool_use",
      thought: "next step",
      toolCalls: [{ name: "t1" }],
    });

    const lines = readTraceLines("test-sid-002");
    expect(lines).toHaveLength(2);
    expect(lines[0].type).toBe("llm_request");
    expect(lines[1].type).toBe("llm_response");
  });

  it("writes one JSON object per line (no embedded newlines)", () => {
    traceNow("test-sid-003", 0, {
      type: "error",
      error: "multi\nline\nerror",
    });
    const raw = readFileSync(traceFilePath("test-sid-003"), "utf8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).error).toBe("multi\nline\nerror");
  });

  it("isolates different sids into different files", () => {
    traceNow("sid-A", 0, { type: "heartbeat" });
    traceNow("sid-B", 0, { type: "heartbeat" });
    traceNow("sid-A", 1, { type: "heartbeat" });

    expect(readTraceLines("sid-A")).toHaveLength(2);
    expect(readTraceLines("sid-B")).toHaveLength(1);
  });

  it("handles all 7 event types without collision", () => {
    const events: Array<Parameters<typeof traceNow>[2]> = [
      { type: "llm_request", phase: "gathering", model: "m", tools: [] },
      { type: "llm_response", stopReason: "tool_use", thought: "x", toolCalls: [] },
      { type: "tool_exec", tool: "t", durationMs: 100, fallbackLevel: 0 },
      { type: "state_change", op: "set", field: "preferences" },
      { type: "phase_change", from: "gathering", to: "searching", reason: "basics complete" },
      { type: "heartbeat", message: "still alive" },
      { type: "error", error: "boom" },
    ];
    events.forEach((e, i) => traceNow("sid-all-types", i, e as any));

    const lines = readTraceLines("sid-all-types");
    expect(lines.map(l => l.type)).toEqual([
      "llm_request", "llm_response", "tool_exec",
      "state_change", "phase_change", "heartbeat", "error",
    ]);
  });
});

describe("trace event construction", () => {
  it("makeTraceEvent fills ts/sid/iter and merges payload", () => {
    const event = makeTraceEvent("sid-x", 5, {
      type: "tool_exec",
      tool: "search_xhs",
      durationMs: 3400,
      fallbackLevel: 0,
      resultSummary: { count: 30 },
    });
    expect(event.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(event.sid).toBe("sid-x");
    expect(event.iter).toBe(5);
    expect(event.type).toBe("tool_exec");
    if (event.type === "tool_exec") {
      expect(event.tool).toBe("search_xhs");
      expect(event.durationMs).toBe(3400);
      expect(event.fallbackLevel).toBe(0);
      expect(event.resultSummary).toEqual({ count: 30 });
    }
  });

  it("traceNow writes to disk and returns the event", () => {
    const event = traceNow("sid-y", 0, {
      type: "phase_change",
      from: "gathering",
      to: "searching",
      reason: "basics complete",
    });
    expect(event.type).toBe("phase_change");
    expect(readTraceLines("sid-y")).toHaveLength(1);
  });

  it("trace() with fully-formed event writes to disk", () => {
    const event: TraceEvent = {
      ts: "2026-06-17T10:00:00.000Z",
      sid: "sid-z",
      iter: 0,
      type: "heartbeat",
      message: "manual",
    };
    trace(event);
    const lines = readTraceLines("sid-z");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual(event);
  });
});

describe("traceDir configuration", () => {
  it("setTraceDir / getTraceDir round-trip", () => {
    setTraceDir("/custom/dir");
    expect(getTraceDir()).toBe("/custom/dir");
    expect(traceFilePath("sid")).toBe("/custom/dir/sid.jsonl");
  });

  it("writes respect overridden dir", () => {
    setTraceDir(tmpDir);
    traceNow("sid-override", 0, { type: "heartbeat" });
    const files = readdirSync(tmpDir);
    expect(files).toContain("sid-override.jsonl");
  });
});
