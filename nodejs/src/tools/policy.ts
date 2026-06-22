import type { Phase } from "../runtime/state.js";

export type ToolName =
  | "collect_preferences"
  | "search_baike"
  | "search_attractions"
  | "search_restaurants"
  | "search_hotels"
  | "search_xhs"
  | "search_weather"
  | "search_travel_guides"
  | "search_flights"
  | "search_trains"
  | "plan_transit"
  | "select_transport"
  | "select_hotel"
  | "finalize_plan";

export interface ToolPhasePolicyEntry {
  name: ToolName;
  description: string;
  allowedPhases: Phase[];
}

const TOOL_PHASE_POLICY: Record<ToolName, ToolPhasePolicyEntry> = {
  collect_preferences: {
    name: "collect_preferences",
    description: "触发前端偏好采集弹窗",
    allowedPhases: ["gathering"],
  },
  search_baike: {
    name: "search_baike",
    description: "百科检索(目的地核心知识)",
    allowedPhases: ["searching"],
  },
  search_attractions: {
    name: "search_attractions",
    description: "景点搜索(高德 POI)",
    allowedPhases: ["searching", "planning"],
  },
  search_restaurants: {
    name: "search_restaurants",
    description: "餐厅搜索(scope=city 城市级 / scope=attraction 景点级)",
    allowedPhases: ["searching", "planning"],
  },
  search_hotels: {
    name: "search_hotels",
    description: "酒店搜索(含 geoConstraint)",
    allowedPhases: ["searching"],
  },
  search_xhs: {
    name: "search_xhs",
    description: "小红书笔记搜索(默认 30,不够再爬 30)",
    allowedPhases: ["searching", "planning"],
  },
  search_weather: {
    name: "search_weather",
    description: "天气查询",
    allowedPhases: ["searching"],
  },
  search_travel_guides: {
    name: "search_travel_guides",
    description: "RAG 攻略检索",
    allowedPhases: ["searching", "planning"],
  },
  search_flights: {
    name: "search_flights",
    description: "航班搜索(Amadeus + WebSearch 兜底),结果填充 candidateTransports",
    allowedPhases: ["searching"],
  },
  search_trains: {
    name: "search_trains",
    description: "高铁/火车搜索(12306 MCP + WebSearch 兜底),结果填充 candidateTransports",
    allowedPhases: ["searching"],
  },
  plan_transit: {
    name: "plan_transit",
    description: "市内交通规划(高德 /direction/transit)",
    allowedPhases: ["planning"],
  },
  select_transport: {
    name: "select_transport",
    description: "用户选择交通(仅限前端 API 调用,LLM 不可用)",
    allowedPhases: [], // 红线:LLM 不得自主选择交通,仅 /api/chat/:sid/select 可触发
  },
  select_hotel: {
    name: "select_hotel",
    description: "用户选择酒店(仅限前端 API 调用,LLM 不可用)",
    allowedPhases: [], // 红线:LLM 不得自主选择酒店,仅 /api/chat/:sid/select 可触发
  },
  finalize_plan: {
    name: "finalize_plan",
    description: "输出最终行程(参数 rawJson=完整 JSON 字符串,格式见 planning 阶段提示)",
    allowedPhases: ["planning"],
  },
};

// Array index = fallback level (0 = primary source, 1 = first fallback, ...).
// ToolExecTraceEvent.fallbackLevel records the actual index used per call.
// Note: search_restaurants is the only tool with 4 entries (Level 3 = rag_travel_guides);
// TransitSegment.fallbackLevel in state.ts is independently typed 0 | 1 | 2 because plan_transit only has 2 fallbacks.
export const TOOL_FALLBACK_CHAIN: Record<ToolName, string[]> = {
  collect_preferences: [],
  search_baike:         ["baike_api", "web_search_baidu", "llm_generated"],
  search_attractions:   ["amap_poi", "web_search", "llm_generated"],
  search_restaurants:   ["amap_poi", "xhs_service", "web_search", "rag_travel_guides"],
  search_hotels:        ["booking_api", "amap_poi", "web_search"],
  search_xhs:           ["xhs_service", "web_search_site_filter", "rag_travel_guides"],
  search_weather:       ["amap_weather", "web_search"],
  search_travel_guides: ["rag_vector", "rag_keyword_fallback"],
  search_flights:       ["amadeus_api", "web_search"],
  search_trains:        ["train12306_mcp", "web_search"],
  plan_transit:         ["amap_direction", "haversine_estimate"],
  select_transport:     [],
  select_hotel:         [],
  finalize_plan:        [],
};

export function isToolAllowedInPhase(name: string, phase: Phase): boolean {
  const entry = TOOL_PHASE_POLICY[name as ToolName];
  if (!entry) return false;
  return entry.allowedPhases.includes(phase);
}

export function listToolsForPhase(phase: Phase): ToolPhasePolicyEntry[] {
  return Object.values(TOOL_PHASE_POLICY).filter(e => e.allowedPhases.includes(phase));
}

export function getToolPolicy(name: string): ToolPhasePolicyEntry | undefined {
  return TOOL_PHASE_POLICY[name as ToolName];
}

export function getAllToolNames(): ToolName[] {
  return Object.keys(TOOL_PHASE_POLICY) as ToolName[];
}

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
    this.lastRefill = now;
  }

  getTokens(): number {
    this.refill();
    return this.tokens;
  }

  tryAcquire(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  async acquire(): Promise<number> {
    let totalWaitMs = 0;
    while (!this.tryAcquire()) {
      const deficit = 1 - this.tokens;
      const waitMs = Math.max(1, Math.ceil((deficit / this.refillPerSec) * 1000));
      await new Promise<void>(resolve => setTimeout(resolve, waitMs));
      totalWaitMs += waitMs;
    }
    return totalWaitMs;
  }
}

export const amapLimiter = new TokenBucket(3, 3);

export async function callAmap<T>(fn: () => Promise<T>): Promise<{ result: T; waitMs: number }> {
  const waitMs = await amapLimiter.acquire();
  const result = await fn();
  return { result, waitMs };
}
