import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { TravelDataSource, TrainSearchParams, RestaurantSearchParams } from "./types.js";
import type { Flight, Hotel, Activity, Train } from "../types/index.js";

const MCP_PORT = 3100;
const STARTUP_TIMEOUT_MS = 15_000;
const TOOL_CALL_TIMEOUT_MS = 20_000;

export class Train12306Source implements TravelDataSource {
  private trainToolName: string | null = null;
  private initialized = false;

  constructor(private readonly logger: Logger) {}

  private async withMcpServer<T>(fn: () => Promise<T>): Promise<T> {
    let proc: ChildProcess | null = null;
    try {
      proc = spawn("npx", ["-y", "12306-mcp", "--port", String(MCP_PORT)], {
        stdio: ["pipe", "pipe", "pipe"],
        shell: true,
        windowsHide: true,
      });

      proc.stderr!.on("data", (chunk: Buffer) => {
        this.logger.debug({ stderr: chunk.toString() }, "train-12306 stderr");
      });

      await this.waitForServer();

      if (!this.initialized) {
        await this.doInit();
      }

      return await fn();
    } finally {
      if (proc && !proc.killed) {
        try { proc.kill(); } catch { /* ignore */ }
      }
    }
  }

  private async waitForServer(): Promise<void> {
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const resp = await fetch(`http://localhost:${MCP_PORT}/mcp`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: "ping", method: "ping", params: {} }),
        });
        if (resp.ok || resp.status === 400) return;
      } catch { /* not ready */ }
    }
    throw new Error("train-12306: server did not start");
  }

  private async doInit(): Promise<void> {
    const initResp = await fetch(`http://localhost:${MCP_PORT}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      signal: AbortSignal.timeout(STARTUP_TIMEOUT_MS),
      body: JSON.stringify({
        jsonrpc: "2.0", id: "init", method: "initialize",
        params: { protocolVersion: "2024-11-05", clientInfo: { name: "travel-planner", version: "1.0.0" }, capabilities: {} },
      }),
    });
    if (!initResp.ok) throw new Error(`init failed: ${initResp.status}`);

    // 12306-mcp HTTP mode needs a fresh process per session, so discover tools on first call
    // The init response itself tells us the server is ready
    this.initialized = true;

    // Try to discover tools
    try {
      const toolsResp = await fetch(`http://localhost:${MCP_PORT}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "tools", method: "tools/list", params: {} }),
      });
      if (toolsResp.ok) {
        const toolsData = await toolsResp.json() as any;
        const tools: Array<{ name: string }> = toolsData.result?.tools ?? [];
        const match = tools.find((t) => /ticket|train|车|票|query|search/i.test(t.name));
        this.trainToolName = match?.name ?? null;
        this.logger.info({ tool: this.trainToolName, allTools: tools.map((t) => t.name) }, "train-12306: tools discovered");
      }
    } catch (err) {
      this.logger.warn({ err }, "train-12306: tools/list failed, will try default tool name");
    }
  }

  private async callTool(args: Record<string, unknown>): Promise<unknown> {
    const toolName = this.trainToolName ?? "query_tickets";
    const resp = await fetch(`http://localhost:${MCP_PORT}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      signal: AbortSignal.timeout(TOOL_CALL_TIMEOUT_MS),
      body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name: toolName, arguments: args } }),
    });
    if (!resp.ok) throw new Error(`tool call failed: ${resp.status}`);
    const data = await resp.json() as { result?: unknown; error?: { message: string } };
    if (data.error) throw new Error(data.error.message);
    return data.result;
  }

  async searchTrains(params: TrainSearchParams): Promise<Train[]> {
    try {
      return await this.withMcpServer(async () => {
        if (!this.trainToolName) {
          this.logger.warn("train-12306: no train tool discovered");
          return [];
        }

        let result: unknown;
        try {
          result = await this.callTool({
            from_station: params.from,
            to_station: params.to,
            date: params.date,
          });
        } catch (err) {
          this.logger.warn({ err }, "train-12306: tool call failed");
          return [];
        }

        return this.parseToolResult(result);
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn({ err: msg }, "train-12306: searchTrains failed");
      return [];
    }
  }

  private parseToolResult(result: unknown): Train[] {
    const content = (result as { content?: Array<{ type: string; text?: string }> })?.content;
    if (!Array.isArray(content)) return [];

    const trains: Train[] = [];
    for (const item of content) {
      if (item.type !== "text" || !item.text) continue;
      try {
        const parsed = JSON.parse(item.text);
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const entry of items) {
          const train = this.toTrain(entry);
          if (train) trains.push(train);
        }
      } catch { /* skip */ }
    }
    return trains;
  }

  private toTrain(raw: unknown): Train | null {
    if (typeof raw !== "object" || raw === null) return null;
    const d = raw as Record<string, unknown>;

    const trainNo = String(d.train_no ?? d.trainNo ?? d.trainno ?? d.车次 ?? d.station_train_code ?? "");
    if (!trainNo) return null;

    const price = Number(d.price ?? d.最低价 ?? d.参考价格 ?? d.min_price ?? 0);
    const durationHours = this.parseDuration(d.duration ?? d.历时 ?? d.run_time ?? d.run_time_span ?? "");
    const departureTime = String(d.departure_time ?? d.start_time ?? d.出发时间 ?? d.start_train_date ?? d.开点 ?? "");
    const arrivalTime = String(d.arrival_time ?? d.end_time ?? d.到达时间 ?? d.到点 ?? "");

    return {
      trainNo,
      trainType: String(d.train_type ?? d.车型 ?? "高铁"),
      departureCity: String(d.from_station ?? d.departure_station ?? d.出发站 ?? d.start_station_telecode ?? ""),
      arrivalCity: String(d.to_station ?? d.arrival_station ?? d.到达站 ?? d.end_station_telecode ?? ""),
      departureTime,
      arrivalTime,
      price: Number.isFinite(price) ? price : 0,
      durationHours,
      seatType: String(d.seat_type ?? d.座位类型 ?? "二等座"),
    };
  }

  private parseDuration(raw: unknown): number {
    if (typeof raw === "number") return raw;
    const str = String(raw);
    const hm = str.match(/(\d+):(\d+)/);
    if (hm) return Number(hm[1]) + Number(hm[2]) / 60;
    const h = str.match(/(\d+(?:\.\d+)?)\s*小时/);
    if (h) return Number(h[1]);
    const mins = str.match(/(\d+)\s*分/);
    if (mins) return Number(mins[1]) / 60;
    return 0;
  }

  searchFlights(): Promise<Flight[]> { return Promise.resolve([]); }
  searchHotels(): Promise<Hotel[]> { return Promise.resolve([]); }
  searchAttractions(): Promise<Activity[]> { return Promise.resolve([]); }
  searchRestaurants(_params: RestaurantSearchParams): Promise<never[]> { return Promise.resolve([]); }

  close(): void {
    this.initialized = false;
  }
}
