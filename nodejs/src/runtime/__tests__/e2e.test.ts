import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runAgentLoop,
  type AgentState,
  type LLMCaller,
  type ToolExecutor,
  type LoopDeps,
  type LLMResponse,
  type PlanDayPlan,
  type BudgetBreakdownV2,
  createInitialAgentState,
  maybeAdvancePhase,
  canFinish,
  applyToolEffects,
} from "../index.js";
import { setTraceDir } from "../trace.js";
import type { UserPreferences } from "../../types/index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "e2e-test-"));
  setTraceDir(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function prefs(over: Partial<UserPreferences> = {}): UserPreferences {
  return {
    preferredDestination: "东京",
    departureCity: "北京",
    startDate: "2026-07-01",
    endDate: "2026-07-05",
    numTravelers: 2,
    budget: 15000,
    interests: [],
    dietaryRestrictions: [],
    accessibilityNeeds: [],
    notes: "",
    outboundTransportPreference: "no_preference",
    returnTransportPreference: "no_preference",
    mustVisitAttractions: [],
    departureTime: "flexible",
    budgetStrictness: "strict",
    travelStyle: "comfort" as any,
    accommodationType: "any",
    preferredHotelBrands: [],
    localTransitMode: "mixed",
    diningPreference: "local_specialties",
    ...over,
  };
}

function dayPlans(): PlanDayPlan[] {
  return Array.from({ length: 4 }, (_, i) => ({
    dayIdx: i,
    date: `2026-07-0${i + 1}`,
    dining: [],
    transitTips: [],
  }));
}

function budget(): BudgetBreakdownV2 {
  return {
    totalCost: 12000,
    byCategory: { transport: 3000, accommodation: 4000, food: 3000, attractions: 1500, other: 500 },
    budgetLimit: 15000,
    isWithinBudget: true,
    variance: -3000,
  };
}

function emptySchemaLookup() {
  return (_name: string) => undefined;
}

function makeMockExecutor(handler: (name: string, input: any, state: AgentState) => any): ToolExecutor {
  return {
    async execute(call, state) {
      return handler(call.name, call.input, state);
    },
  };
}

function makeMockCaller(responses: LLMResponse[]): LLMCaller & { calls: any[] } {
  const calls: any[] = [];
  let i = 0;
  return {
    calls,
    async call(_opts) {
      calls.push(_opts);
      const r = responses[i++];
      if (!r) throw new Error(`mock caller exhausted at index ${i - 1}`);
      return r;
    },
  };
}

describe("P0-A E2E: full flow from searching to completed", () => {
  it("searching → selecting → planning → completed with realistic tool interactions", async () => {
    const caller = makeMockCaller([
      // Iter 0: searching → LLM parallel searches
      {
        stopReason: "tool_use",
        text: "<thought>phase=searching,并行获取景点/酒店/百科/小红书</thought>",
        toolCalls: [
          { id: "tu1", name: "search_attractions", input: {} },
          { id: "tu2", name: "search_hotels", input: {} },
          { id: "tu3", name: "search_baike", input: {} },
          { id: "tu4", name: "search_xhs", input: {} },
        ],
      },
      // Iter 1: searching → LLM gets more info (transports already seeded)
      {
        stopReason: "tool_use",
        text: "<thought>还需要天气和餐饮信息</thought>",
        toolCalls: [
          { id: "tu5", name: "search_restaurants", input: { scope: "city" } },
          { id: "tu6", name: "search_weather", input: {} },
        ],
      },
      // Iter 2: selecting → LLM pushes transport + hotel choices
      {
        stopReason: "tool_use",
        text: "<thought>候选已齐全,推送交通和酒店供选择</thought>",
        toolCalls: [
          { id: "tu7", name: "select_transport", input: { outboundId: "f1", returnId: "t1" } },
          { id: "tu8", name: "select_hotel", input: { hotelId: "h1" } },
        ],
      },
      // Iter 3: selecting → no tools (user selected), auto-advance to planning
      {
        stopReason: "end_turn",
        text: "<thought>选择完成,进入行程编排</thought>",
        toolCalls: [],
      },
      // Iter 4: planning → plan_transit for day 0
      {
        stopReason: "tool_use",
        text: "<thought>编排第1天,查景点间交通</thought>",
        toolCalls: [
          { id: "tu9", name: "plan_transit", input: { from: "浅草寺", to: "晴空塔", dayIdx: 0 } },
        ],
      },
      // Iter 5: planning → finalize
      {
        stopReason: "tool_use",
        text: "<thought>编排完成,调用 finalize_plan 交付</thought>",
        toolCalls: [{ id: "tu10", name: "finalize_plan", input: { rawJson: "{}" } }],
      },
    ]);

    let toolExecCount = 0;

    const executor = makeMockExecutor((name, input) => {
      toolExecCount++;
      switch (name) {
        case "search_attractions":
          return { toolName: name, success: true, data: { items: [{ name: "浅草寺", geoLocation: { lat: 35.71, lon: 139.79 } }, { name: "晴空塔", geoLocation: { lat: 35.71, lon: 139.81 } }], scores: { "浅草寺": 0.92, "晴空塔": 0.88 } } };
        case "search_hotels":
          return { toolName: name, success: true, data: { items: [{ name: "Hotel A", pricePerNight: 5000 }], scores: { "Hotel A": 0.85 } } };
        case "search_baike":
          return { toolName: name, success: true, data: { summary: "东京是日本首都..." } };
        case "search_xhs":
          return { toolName: name, success: true, data: { notes: [{ noteId: "1", title: "东京攻略" }], top: [{ noteId: "1", title: "东京攻略" }] } };
        case "search_restaurants":
          return { toolName: name, success: true, data: { scope: input.scope ?? "city", items: [{ name: "Ramen Ya" }], scores: {} } };
        case "search_weather":
          return { toolName: name, success: true, data: { date: "2026-07-01", weather: "晴", highC: 31, lowC: 24, rainProbability: 10 } };
        case "select_transport":
          return { toolName: name, success: true, data: { outbound: { id: "f1", flightNo: "CA123", price: 1500 }, return: { id: "t1", trainNo: "G1", price: 1000 } } };
        case "select_hotel":
          return { toolName: name, success: true, data: { hotel: { name: "Hotel A", pricePerNight: 5000 } } };
        case "plan_transit":
          return { toolName: name, success: true, data: { dayIdx: input.dayIdx, transit: { from: input.from, to: input.to, mode: "transit", durationMin: 30, distanceKm: 3, cost: "¥4", costAmount: 4, steps: [], fallbackLevel: 0 } } };
        case "finalize_plan":
          return { toolName: name, success: true, data: { plan: { dayPlans: dayPlans() }, breakdown: budget(), withinBudget: true } };
        default:
          return { toolName: name, success: false, error: `unknown: ${name}` };
      }
    });

    // Start from searching with pre-seeded transport candidates (from conversation context)
    const state: AgentState = {
      ...createInitialAgentState(),
      phase: "searching",
      preferences: prefs(),
      candidateTransports: [
        { id: "f1", type: "flight", flightNo: "CA123", price: 1500 },
        { id: "t1", type: "train", trainNo: "G1", price: 1000 },
      ],
      candidateHotels: [{ name: "Hotel A", pricePerNight: 5000 }],
    };

    const deps: LoopDeps = {
      llmCaller: caller,
      schemaLookup: emptySchemaLookup(),
      toolExecutor: executor,
    };

    const result = await runAgentLoop("e2e-test-full", state, [], "继续东京行程", deps);

    // === Acceptance criteria from v2 §8 ===

    // 1. Final state is completed
    expect(result.state.phase).toBe("completed");
    expect(canFinish(result.state)).toBe(true);

    // 2. Multiple iterations
    expect(result.iterations).toBeGreaterThanOrEqual(5);

    // 3. <thought> was parsed and preserved
    expect(result.state.lastThought).toBeDefined();
    expect(result.state.lastThought!.length).toBeGreaterThan(0);

    // 4. Tools executed across phases
    expect(toolExecCount).toBeGreaterThanOrEqual(8);

    // 5. LLM received tool definitions for searching phase (7 tools)
    expect(caller.calls[0]?.tools?.length).toBeGreaterThanOrEqual(4);

    // 6. Immutable: original unchanged
    expect(state.phase).toBe("searching");

    // 7. state fully populated
    expect(result.state.candidateAttractions?.length).toBeGreaterThanOrEqual(1);
    expect(result.state.baikeKnowledge).toBeDefined();
    expect(result.state.selectedOutbound).toBeDefined();
    expect(result.state.selectedReturn).toBeDefined();
    expect(result.state.selectedHotel).toBeDefined();
    expect(result.state.dayPlans?.length).toBe(4);
    expect(result.state.budgetBreakdown).toBeDefined();
    expect(result.state.budgetBreakdown!.isWithinBudget).toBe(true);

    // 8. Iterations = LLM calls
    expect(result.iterations).toBe(caller.calls.length);
  }, 15000);
});

describe("P0-A E2E: budget loop", () => {
  it("over-budget finalize_plan → reverted → second call within budget", async () => {
    const caller = makeMockCaller([
      {
        stopReason: "tool_use",
        text: "<thought>规划完成,但预算超了,调整后重试</thought>",
        toolCalls: [{ id: "tu1", name: "finalize_plan", input: { rawJson: "{}" } }],
      },
      {
        stopReason: "tool_use",
        text: "<thought>调整了预算,重新提交</thought>",
        toolCalls: [{ id: "tu2", name: "finalize_plan", input: { rawJson: "{}" } }],
      },
    ]);

    const overBudget = budget();
    overBudget.totalCost = 20000;
    overBudget.isWithinBudget = false;
    overBudget.variance = 5000;

    let callNum = 0;
    const executor = makeMockExecutor((name) => {
      if (name === "finalize_plan") {
        callNum++;
        const b = callNum === 1 ? overBudget : budget();
        return { toolName: name, success: true, data: { plan: { dayPlans: dayPlans() }, breakdown: b, withinBudget: b.isWithinBudget } };
      }
      return { toolName: name, success: true, data: {} };
    });

    const state: AgentState = {
      ...createInitialAgentState(),
      phase: "planning",
      preferences: prefs(),
      selectedOutbound: { id: "X" } as any,
      selectedReturn: { id: "Y" } as any,
      selectedHotel: { name: "H" } as any,
    };

    const result = await runAgentLoop("e2e-budget", state, [], "finalize", {
      llmCaller: caller,
      schemaLookup: emptySchemaLookup(),
      toolExecutor: executor,
    });

    // budgetRound increments, then second call succeeds
    expect(result.state.budgetRound).toBe(1);
    expect(result.state.budgetBreakdown?.isWithinBudget).toBe(true);
    expect(result.state.phase).toBe("completed");
    expect(callNum).toBe(2);
  }, 10000);
});

describe("P0-A E2E: phase transition unit consistency", () => {
  it("gathering → searching when prefs complete", () => {
    const s: AgentState = {
      ...createInitialAgentState(),
      preferences: prefs(),
    };
    const next = maybeAdvancePhase(s);
    expect(next.phase).toBe("searching");
    expect(s.phase).toBe("gathering"); // immutable
  });

  it("searching → selecting when candidates ready", () => {
    const s: AgentState = {
      ...createInitialAgentState(),
      phase: "searching",
      preferences: prefs(),
      candidateTransports: [{} as any],
      candidateHotels: [{} as any],
    };
    const next = maybeAdvancePhase(s);
    expect(next.phase).toBe("selecting");
  });

  it("selecting → planning when all selected", () => {
    const s: AgentState = {
      ...createInitialAgentState(),
      phase: "selecting",
      preferences: prefs(),
      selectedOutbound: {} as any,
      selectedReturn: {} as any,
      selectedHotel: {} as any,
    };
    const next = maybeAdvancePhase(s);
    expect(next.phase).toBe("planning");
  });

  it("planning → completed when dayPlans full and budget OK", () => {
    const s: AgentState = {
      ...createInitialAgentState(),
      phase: "planning",
      preferences: prefs(),
      dayPlans: dayPlans(),
      budgetBreakdown: budget(),
      lastThought: "全部完成",
    };
    const next = maybeAdvancePhase(s);
    expect(next.phase).toBe("completed");
  });

  it("planning stays planning when lastThought has CONTINUE_SIGNALS", () => {
    const s: AgentState = {
      ...createInitialAgentState(),
      phase: "planning",
      preferences: prefs(),
      dayPlans: dayPlans(),
      budgetBreakdown: budget(),
      lastThought: "还需要调整交通",
    };
    const next = maybeAdvancePhase(s);
    expect(next.phase).toBe("planning");
  });

  it("applyToolEffects: immutable chain", () => {
    const state = createInitialAgentState();
    const r1 = applyToolEffects(state, [
      { toolName: "search_baike", success: true, data: { summary: "东京是..." }, fallbackLevel: 0 },
    ]);
    expect(r1.baikeKnowledge).toBe("东京是...");

    const r2 = applyToolEffects(r1, [
      { toolName: "search_attractions", success: true, data: { items: [{ name: "浅草寺" }], scores: { "浅草寺": 0.9 } }, fallbackLevel: 0 },
    ]);
    expect(r2.candidateAttractions?.length).toBe(1);
    expect(r1.candidateAttractions).toBeUndefined();

    const r3 = applyToolEffects(r2, [
      { toolName: "select_hotel", success: true, data: { hotel: { name: "Hotel A" } }, fallbackLevel: 0 },
    ]);
    expect(r3.selectedHotel?.name).toBe("Hotel A");
    expect(r2.selectedHotel).toBeUndefined();
  });
});
