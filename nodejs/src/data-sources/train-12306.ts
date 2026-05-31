import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { TravelDataSource, TrainSearchParams, RestaurantSearchParams } from "./types.js";
import type { Flight, Hotel, Activity, Train } from "../types/index.js";

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type McpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

const INIT_TIMEOUT_MS = 15_000;
const TOOL_CALL_TIMEOUT_MS = 20_000;

export class Train12306Source implements TravelDataSource {
  private proc: ChildProcess | null = null;
  private buf = "";
  private pending = new Map<string, {
    resolve: (value: JsonRpcResponse) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private ready = false;
  private trainTools: McpTool[] = [];
  private initPromise: Promise<void> | null = null;

  constructor(private readonly logger: Logger) {}

  private ensureProcess(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.startAndInitialize();
    return this.initPromise;
  }

  private startAndInitialize(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        this.proc = spawn("npx", ["-y", "12306-mcp"], {
          stdio: ["pipe", "pipe", "pipe"],
          shell: true,
          windowsHide: true,
        });
      } catch (err) {
        this.logger.warn({ err }, "train-12306: failed to spawn process");
        reject(err);
        return;
      }

      this.proc.stdout!.on("data", (chunk: Buffer) => this.onStdout(chunk));
      this.proc.stderr!.on("data", (chunk: Buffer) => {
        this.logger.debug({ stderr: chunk.toString() }, "train-12306 stderr");
      });
      this.proc.on("error", (err) => {
        this.logger.warn({ err }, "train-12306: process error");
      });
      this.proc.on("exit", (code) => {
        this.logger.debug({ code }, "train-12306: process exited");
        this.proc = null;
        this.ready = false;
      });

      const timer = setTimeout(() => {
        this.logger.warn("train-12306: init timeout");
        reject(new Error("init timeout"));
      }, INIT_TIMEOUT_MS);

      this.sendRequest("initialize", {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "travel-planner", version: "1.0.0" },
        capabilities: {},
      })
        .then(() => {
          this.sendNotification("notifications/initialized");
          return this.sendRequest("tools/list", {});
        })
        .then((res) => {
          clearTimeout(timer);
          const tools = (res.result as { tools?: McpTool[] })?.tools ?? [];
          const pattern = /train|ticket|车|票/i;
          this.trainTools = tools.filter((t) => pattern.test(t.name));
          this.ready = true;
          this.logger.info({ toolCount: this.trainTools.length, tools: this.trainTools.map((t) => t.name) }, "train-12306: initialized");
          resolve();
        })
        .catch((err) => {
          clearTimeout(timer);
          this.logger.warn({ err }, "train-12306: init failed");
          reject(err);
        });
    });
  }

  private onStdout(chunk: Buffer): void {
    this.buf += chunk.toString();
    const lines = this.buf.split("\n");
    this.buf = lines.pop()!;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcResponse;
        if (msg.id && this.pending.has(msg.id)) {
          const entry = this.pending.get(msg.id)!;
          clearTimeout(entry.timer);
          this.pending.delete(msg.id);
          entry.resolve(msg);
        }
      } catch {
        // ignore non-JSON lines
      }
    }
  }

  private sendRequest(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
      const payload = JSON.stringify(req) + "\n";

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }, TOOL_CALL_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });

      this.proc!.stdin!.write(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  private sendNotification(method: string, params?: Record<string, unknown>): void {
    const notif: JsonRpcNotification = { jsonrpc: "2.0", method, ...(params ? { params } : {}) };
    const payload = JSON.stringify(notif) + "\n";
    this.proc!.stdin!.write(payload);
  }

  async searchTrains(params: TrainSearchParams): Promise<Train[]> {
    try {
      await this.ensureProcess();
    } catch {
      this.logger.warn("train-12306: searchTrains skipped, init failed");
      return [];
    }

    if (this.trainTools.length === 0) {
      this.logger.warn("train-12306: no train tools discovered");
      return [];
    }

    const tool = this.trainTools[0];
    let res: JsonRpcResponse;
    try {
      res = await this.sendRequest("tools/call", {
        name: tool.name,
        arguments: {
          from_station: params.from,
          to_station: params.to,
          date: params.date,
        },
      });
    } catch (err) {
      this.logger.warn({ err }, "train-12306: tool call failed");
      return [];
    }

    if (res.error) {
      this.logger.warn({ error: res.error }, "train-12306: tool returned error");
      return [];
    }

    return this.parseToolResult(res.result);
  }

  private parseToolResult(result: unknown): Train[] {
    const content = (result as { content?: Array<{ type: string; text?: string }> })?.content;
    if (!Array.isArray(content)) return [];

    const trains: Train[] = [];

    for (const item of content) {
      if (item.type !== "text" || !item.text) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(item.text);
      } catch {
        continue;
      }

      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          const train = this.toTrain(entry);
          if (train) trains.push(train);
        }
      } else if (typeof parsed === "object" && parsed !== null) {
        const data = parsed as Record<string, unknown>;
        const list = data.trains ?? data.data ?? data.result ?? data.list ?? [parsed];
        const items = Array.isArray(list) ? list : [list];
        for (const entry of items) {
          const train = this.toTrain(entry);
          if (train) trains.push(train);
        }
      }
    }

    return trains;
  }

  private toTrain(raw: unknown): Train | null {
    if (typeof raw !== "object" || raw === null) return null;
    const d = raw as Record<string, unknown>;

    const trainNo = String(d.train_no ?? d.trainNo ?? d.trainno ?? d.车次 ?? "");
    if (!trainNo) return null;

    const price = Number(d.price ?? d.最低价 ?? d.参考价格 ?? d.price_info ?? 0);
    const durationHours = this.parseDuration(d.duration ?? d.历时 ?? d.run_time ?? "");
    const departureTime = String(d.departure_time ?? d.start_time ?? d.出发时间 ?? d.开点 ?? "");
    const arrivalTime = String(d.arrival_time ?? d.end_time ?? d.到达时间 ?? d.到点 ?? "");

    return {
      trainNo,
      trainType: String(d.train_type ?? d.车型 ?? "高铁"),
      departureCity: String(d.from_station ?? d.departure_station ?? d.出发站 ?? ""),
      arrivalCity: String(d.to_station ?? d.arrival_station ?? d.到达站 ?? ""),
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

  searchFlights(): Promise<Flight[]> {
    return Promise.resolve([]);
  }

  searchHotels(): Promise<Hotel[]> {
    return Promise.resolve([]);
  }

  searchAttractions(): Promise<Activity[]> {
    return Promise.resolve([]);
  }

  searchRestaurants(_params: RestaurantSearchParams): Promise<never[]> {
    return Promise.resolve([]);
  }

  close(): void {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("closed"));
    }
    this.pending.clear();
    this.ready = false;
    this.initPromise = null;
  }
}
