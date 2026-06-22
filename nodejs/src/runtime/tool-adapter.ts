import type { SourceResolver } from "../data-sources/source-resolver.js";
import type { RegisteredTool, ToolResult } from "../tools/types.js";
import type { ToolExecutor } from "./agent-loop.js";
import type { ToolDef } from "../api/llm-client.js";
import type { ToolCall } from "./validate-tool-calls.js";
import type { ToolResultLike } from "./apply-tool-effects.js";
import type { AgentState } from "./state.js";
import { settings } from "../config/settings.js";

import { createSearchAttractionsTool } from "../tools/definitions/search-attractions.js";
import { createSearchFlightsTool } from "../tools/definitions/search-flights.js";
import { createSearchHotelsTool } from "../tools/definitions/search-hotels.js";
import { createSearchTrainsTool } from "../tools/definitions/search-trains.js";
import { createSearchBaikeTool } from "../tools/definitions/search-baike.js";
import { createSearchRestaurantsTool } from "../tools/definitions/search-restaurants.js";
import { createSearchXhsTool } from "../tools/definitions/search-xhs.js";
import { createSearchWeatherTool } from "../tools/definitions/search-weather.js";
import { createSearchTravelGuidesTool } from "../tools/definitions/search-travel-guides.js";
import { createSelectTransportTool } from "../tools/definitions/select-transport.js";
import { createSelectHotelTool } from "../tools/definitions/select-hotel.js";
import { executePlanTransit, type AmapClient, type LatLng, type AmapDirection } from "../tools/definitions/plan-transit.js";
import { executeFinalizePlan } from "../tools/definitions/finalize-plan.js";

import type { Logger } from "pino";

function toToolResultLike(toolName: string, result: ToolResult, fallbackLevel?: number): ToolResultLike {
  const inner = (result.data && typeof result.data === "object" && !Array.isArray(result.data))
    ? result.data as Record<string, unknown>
    : {};
  return {
    toolName,
    success: result.success,
    data: result.data,
    error: result.error,
    fallbackLevel: fallbackLevel ?? (result.success ? 0 : 1),
    ...inner,
  };
}

function createAmapClient(): AmapClient {
  const key = settings.AMAP_API_KEY;

  return {
    async geocode(name: string, city?: string): Promise<LatLng | null> {
      if (!key) return null;
      try {
        const qs = new URLSearchParams({
          key,
          keywords: name,
          city: city || "北京",
          offset: "1",
        });
        const resp = await fetch(`https://restapi.amap.com/v5/place/text?${qs}`, {
          signal: AbortSignal.timeout(10_000),
        });
        const data = await resp.json() as { status: string; pois?: Array<{ location: string; cityname: string }> };
        if (data.status !== "1" || !data.pois?.length) return null;
        const [lng, lat] = data.pois[0].location.split(",").map(Number);
        return { lat, lng };
      } catch {
        return null;
      }
    },

    async directionTransit(start: LatLng, end: LatLng): Promise<AmapDirection | null> {
      if (!key) return null;
      try {
        const qs = new URLSearchParams({
          key,
          origin: `${start.lng},${start.lat}`,
          destination: `${end.lng},${end.lat}`,
          city1: "010",
          city2: "010",
          strategy: "2",
        });
        const resp = await fetch(`https://restapi.amap.com/v5/direction/transit/integrated?${qs}`, {
          signal: AbortSignal.timeout(15_000),
        });
        const data = await resp.json() as { status: string; route?: { transits?: Array<{ cost?: { duration?: string }; distance?: string; walking_distance?: string; steps?: Array<{ instruction: string }> }> } };
        if (data.status !== "1" || !data.route?.transits?.length) return null;
        const plan = data.route.transits[0];
        return {
          durationSec: Math.round(parseInt(plan.cost?.duration ?? "0") / 60) * 60 || 1800,
          distanceMeters: parseInt(plan.distance ?? "0") || 5000,
          cost: null,
          steps: plan.steps?.map((s: { instruction: string }) => s.instruction) ?? [],
        };
      } catch {
        return null;
      }
    },
  };
}

function buildTools(resolver: SourceResolver, log?: Logger): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const add = (t: RegisteredTool) => tools.set(t.name, t);

  add(createSearchAttractionsTool(resolver, log));
  add(createSearchFlightsTool(resolver, log));
  add(createSearchHotelsTool(resolver, log));
  add(createSearchTrainsTool(resolver, log));
  add(createSearchBaikeTool());
  add(createSearchRestaurantsTool());
  add(createSearchXhsTool());
  add(createSearchWeatherTool());
  add(createSearchTravelGuidesTool());
  add(createSelectTransportTool());
  add(createSelectHotelTool());

  add({
    name: "plan_transit",
    description: "市内交通规划(必填: from=起点, to=终点, dayIdx=天序号从0开始, mode=transit|walking|driving)",
    input_schema: {
      type: "object",
      properties: {
        from:   { type: "string", description: "起点名称" },
        to:     { type: "string", description: "终点名称" },
        dayIdx: { type: "integer", description: "天序号从0开始" },
        mode:   { type: "string", enum: ["transit", "walking", "driving", "rideshare"], description: "交通方式" },
      },
      required: ["from", "to", "dayIdx"],
    },
    execute: async () => ({ success: false, error: "plan_transit is handled by special executor" }),
  });

  add({
    name: "finalize_plan",
    description: "输出最终行程(参数 rawJson=完整 JSON 字符串,格式见 planning 阶段提示)",
    input_schema: {
      type: "object",
      properties: {
        rawJson: { type: "string", description: "完整的 TravelPlan JSON 字符串" },
      },
      required: ["rawJson"],
    },
    execute: async () => ({ success: false, error: "finalize_plan is handled by special executor" }),
  });

  return tools;
}

export function getAgentLoopToolDefs(resolver: SourceResolver, log?: Logger): ToolDef[] {
  const tools = buildTools(resolver, log);
  return [...tools.values()].map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Record<string, unknown>,
  }));
}

export function createAgentLoopToolExecutor(
  resolver: SourceResolver,
  log?: Logger,
): ToolExecutor {
  const tools = buildTools(resolver, log);
  const amapClient = createAmapClient();

  return {
    async execute(call: ToolCall, state: AgentState): Promise<ToolResultLike> {
      log?.info({ tool: call.name }, "executing tool");

      if (call.name === "plan_transit") {
        try {
          return await executePlanTransit(call.input as any, state, amapClient);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { toolName: call.name, success: false, error: msg };
        }
      }

      if (call.name === "finalize_plan") {
        try {
          return await executeFinalizePlan(call.input as any, state);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { toolName: call.name, success: false, error: msg };
        }
      }

      const tool = tools.get(call.name);
      if (tool) {
        try {
          const result = await tool.execute(call.input as Record<string, unknown>);
          return toToolResultLike(call.name, result);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { toolName: call.name, success: false, error: msg };
        }
      }

      log?.warn({ tool: call.name }, "unknown tool");
      return { toolName: call.name, success: false, error: `未知工具: ${call.name}` };
    },
  };
}
