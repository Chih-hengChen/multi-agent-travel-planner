import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runAgentLoop,
  pickModel,
  pickTemperature,
  pickMaxTokens,
  stateSummary,
  buildSystemPrompt,
  forceContinuePrompt,
  rejectionPrompt,
  MAX_ITERATIONS,
  MAX_REJECTIONS_PER_ITER,
  AgentLoopOverflowError,
  RejectionLoopError,
  type LLMCaller,
  type LLMResponse,
  type ToolExecutor,
  type LoopDeps,
} from "../agent-loop.js";
import { setTraceDir } from "../trace.js";
import {
  type AgentState,
  type PlanDayPlan,
  type BudgetBreakdownV2,
  createInitialAgentState,
} from "../state.js";
import type { ToolResultLike } from "../apply-tool-effects.js";
import type { UserPreferences } from "../../types/index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-loop-test-"));
  setTraceDir(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makePrefs(over: Partial<UserPreferences> = {}): UserPreferences {
  return {
    budget: 15000,
    travelStyle: "comfort" as any,
    departureCity: "北京",
    startDate: "2026-07-01",
    endDate: "2026-07-02",
    numTravelers: 2,
    interests: [],
    dietaryRestrictions: [],
    accessibilityNeeds: [],
    notes: "",
    outboundTransportPreference: "no_preference",
    returnTransportPreference: "no_preference",
    mustVisitAttractions: [],
    departureTime: "flexible",
    budgetStrictness: "strict",
    accommodationType: "any",
    preferredHotelBrands: [],
    localTransitMode: "mixed",
    diningPreference: "local_specialties",
    preferredDestination: "东京",
    ...over,
  } as UserPreferences;
}

function makeBudget(over: Partial<BudgetBreakdownV2> = {}): BudgetBreakdownV2 {
  return {
    totalCost: 100,
    byCategory: { transport: 0, accommodation: 0, food: 0, attractions: 0, other: 0 },
    budgetLimit: 15000,
    isWithinBudget: true,
    variance: -14900,
    ...over,
  };
}

function makeDayPlans(): PlanDayPlan[] {
  return [{ dayIdx: 0, date: "2026-07-01", dining: [], transitTips: [] }];
}

function makeState(over: Partial<AgentState> = {}): AgentState {
  return { ...createInitialAgentState(), ...over };
}

function emptySchemaLookup() {
  return () => undefined;
}

function makeMockExecutor(handler: (name: string, input: any, state: AgentState) => ToolResultLike): ToolExecutor {
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
    async call(opts) {
      calls.push(opts);
      const r = responses[i++];
      if (!r) throw new Error(`mock caller exhausted at index ${i - 1}`);
      return r;
    },
  };
}

describe("helpers", () => {
  it("pickModel returns heavy-llm only for planning", () => {
    expect(pickModel("gathering")).toBe("light-llm");
    expect(pickModel("searching")).toBe("light-llm");
    expect(pickModel("selecting")).toBe("light-llm");
    expect(pickModel("planning")).toBe("heavy-llm");
    expect(pickModel("completed")).toBe("light-llm");
  });

  it("pickTemperature returns 0.7 for planning, 0.1 for selecting", () => {
    expect(pickTemperature("planning")).toBe(0.7);
    expect(pickTemperature("selecting")).toBe(0.1);
  });

  it("pickMaxTokens returns 8192 for planning, 4096 otherwise", () => {
    expect(pickMaxTokens("planning")).toBe(8192);
    expect(pickMaxTokens("gathering")).toBe(4096);
  });

  it("stateSummary lists all populated fields", () => {
    const state = makeState({
      preferences: makePrefs(),
      candidateAttractions: [{ name: "故宫" } as any],
      selectedHotel: { name: "H1" } as any,
    });
    const summary = stateSummary(state);
    expect(summary).toContain("目的地:东京");
    expect(summary).toContain("候选景点:1 个");
    expect(summary).toContain("已选酒店:H1");
  });

  it("stateSummary returns placeholder for empty state", () => {
    expect(stateSummary(makeState())).toBe("(state 为空)");
  });

  it("buildSystemPrompt includes BASE + phase + state + tools", () => {
    const state = makeState({ phase: "searching" });
    const prompt = buildSystemPrompt(state);
    expect(prompt).toContain("ReAct 推理要求");
    expect(prompt).toContain("【当前阶段:searching");
    expect(prompt).toContain("search_attractions");
    expect(prompt).toContain("【当前 state 摘要】");
  });

  it("forceContinuePrompt mentions current phase", () => {
    const prompt = forceContinuePrompt(makeState({ phase: "gathering" }));
    expect(prompt).toContain("gathering");
    expect(prompt).toContain("<thought>");
  });

  it("rejectionPrompt formats multiple rejections with code", () => {
    const prompt = rejectionPrompt([
      { call: { name: "x", input: {} }, code: "PHASE_NOT_ALLOWED", reason: "not in phase" },
      { call: { name: "y", input: {} }, code: "SCHEMA_INVALID", reason: "bad input" },
    ]);
    expect(prompt).toContain("[PHASE_NOT_ALLOWED] x");
    expect(prompt).toContain("[SCHEMA_INVALID] y");
  });
});

describe("runAgentLoop - happy path", () => {
  it("finishes immediately when canFinish is true (LLM returns no tools)", async () => {
    const completedState = makeState({
      phase: "completed",
      preferences: makePrefs(),
      dayPlans: makeDayPlans(),
      budgetBreakdown: makeBudget(),
    });
    const caller = makeMockCaller([
      { stopReason: "end_turn", text: "all done", toolCalls: [] },
    ]);
    const deps: LoopDeps = {
      llmCaller: caller,
      schemaLookup: emptySchemaLookup(),
      toolExecutor: makeMockExecutor(() => ({ toolName: "", success: true, data: {} })),
    };

    const result = await runAgentLoop("test-sid-001", completedState, [], "go", deps);
    expect(result.state.phase).toBe("completed");
    expect(result.iterations).toBe(1);
    expect(caller.calls).toHaveLength(1);
  });

  it("executes finalize_plan on planning state, transitions to completed (1 iter)", async () => {
    const planningState = makeState({
      phase: "planning",
      preferences: makePrefs(),
      selectedOutbound: { id: "X" } as any,
      selectedReturn: { id: "Y" } as any,
      selectedHotel: { name: "H" } as any,
    });
    const caller = makeMockCaller([
      {
        stopReason: "tool_use",
        text: "<thought>finalizing plan</thought>",
        toolCalls: [{ id: "tu1", name: "finalize_plan", input: { rawJson: "{}" } }],
      },
    ]);
    const executor = makeMockExecutor((name) => ({
      toolName: name,
      success: true,
      data: name === "finalize_plan"
        ? { plan: { dayPlans: makeDayPlans() }, breakdown: makeBudget(), withinBudget: true }
        : {},
    }));
    const deps: LoopDeps = {
      llmCaller: caller,
      schemaLookup: emptySchemaLookup(),
      toolExecutor: executor,
    };

    const result = await runAgentLoop("test-sid-002", planningState, [], "finalize", deps);
    expect(result.state.phase).toBe("completed");
    expect(result.state.budgetBreakdown).toBeDefined();
    expect(result.iterations).toBe(1);
  });

  it("preserves <thought> in state.lastThought", async () => {
    const planningState = makeState({
      phase: "planning",
      preferences: makePrefs(),
      selectedOutbound: { id: "X" } as any,
      selectedReturn: { id: "Y" } as any,
      selectedHotel: { name: "H" } as any,
    });
    const caller = makeMockCaller([
      {
        stopReason: "tool_use",
        text: "<thought>need to finalize now</thought>",
        toolCalls: [{ name: "finalize_plan", input: { rawJson: "{}" } }],
      },
    ]);
    const executor = makeMockExecutor((name) => ({
      toolName: name, success: true,
      data: name === "finalize_plan"
        ? { plan: { dayPlans: makeDayPlans() }, breakdown: makeBudget(), withinBudget: true }
        : {},
    }));
    const deps: LoopDeps = {
      llmCaller: caller,
      schemaLookup: emptySchemaLookup(),
      toolExecutor: executor,
    };

    const result = await runAgentLoop("test-sid-003", planningState, [], "go", deps);
    expect(result.state.lastThought).toContain("need to finalize now");
  });
});

describe("runAgentLoop - _pendingBudgetFeedback consumption", () => {
  it("pushes pending feedback as user message before next LLM call", async () => {
    const completedState = makeState({
      phase: "completed",
      preferences: makePrefs(),
      dayPlans: makeDayPlans(),
      budgetBreakdown: makeBudget(),
      _pendingBudgetFeedback: "请调整预算",
    });
    const caller = makeMockCaller([
      { stopReason: "end_turn", text: "ok", toolCalls: [] },
    ]);
    const deps: LoopDeps = {
      llmCaller: caller,
      schemaLookup: emptySchemaLookup(),
      toolExecutor: makeMockExecutor(() => ({ toolName: "", success: true, data: {} })),
    };

    const result = await runAgentLoop("test-sid-004", completedState, [], "any", deps);
    expect(result.state._pendingBudgetFeedback).toBeUndefined();
    expect(caller.calls[0].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: "请调整预算" }),
    ]));
  });
});

describe("runAgentLoop - rejection handling", () => {
  it("sends rejection prompt back when validation fails, then LLM corrects and finishes", async () => {
    const completedState = makeState({
      phase: "completed",
      preferences: makePrefs(),
      dayPlans: makeDayPlans(),
      budgetBreakdown: makeBudget(),
    });
    const caller = makeMockCaller([
      {
        stopReason: "tool_use",
        text: "",
        toolCalls: [{ name: "search_attractions", input: {} }],
      },
      { stopReason: "end_turn", text: "", toolCalls: [] },
    ]);
    const deps: LoopDeps = {
      llmCaller: caller,
      schemaLookup: emptySchemaLookup(),
      toolExecutor: makeMockExecutor(() => ({ toolName: "", success: true, data: {} })),
    };

    const result = await runAgentLoop("test-sid-005", completedState, [], "go", deps);
    expect(result.iterations).toBe(2);
    expect(caller.calls[1].messages.some((m: any) =>
      typeof m.content === "string" && m.content.includes("PHASE_NOT_ALLOWED")
    )).toBe(true);
  });

  it("throws RejectionLoopError after MAX_REJECTIONS_PER_ITER consecutive rejections", async () => {
    const completedState = makeState({
      phase: "completed",
      preferences: makePrefs(),
      dayPlans: makeDayPlans(),
      budgetBreakdown: makeBudget(),
    });
    const caller = makeMockCaller([
      { stopReason: "tool_use", text: "", toolCalls: [{ name: "search_attractions", input: {} }] },
      { stopReason: "tool_use", text: "", toolCalls: [{ name: "search_attractions", input: {} }] },
      { stopReason: "tool_use", text: "", toolCalls: [{ name: "search_attractions", input: {} }] },
    ]);
    const deps: LoopDeps = {
      llmCaller: caller,
      schemaLookup: emptySchemaLookup(),
      toolExecutor: makeMockExecutor(() => ({ toolName: "", success: true, data: {} })),
    };

    await expect(runAgentLoop("test-sid-006", completedState, [], "go", deps))
      .rejects.toThrow(RejectionLoopError);
  });
});

describe("runAgentLoop - parallel tool execution", () => {
  it("executes multiple tool calls in one iteration (including finalize_plan)", async () => {
    const planningState = makeState({
      phase: "planning",
      preferences: makePrefs(),
      selectedOutbound: { id: "X" } as any,
      selectedReturn: { id: "Y" } as any,
      selectedHotel: { name: "H" } as any,
    });
    const caller = makeMockCaller([
      {
        stopReason: "tool_use",
        text: "",
        toolCalls: [
          { id: "tu1", name: "search_attractions", input: {} },
          { id: "tu2", name: "finalize_plan", input: { rawJson: "{}" } },
        ],
      },
    ]);
    const executedNames: string[] = [];
    const executor = makeMockExecutor((name) => {
      executedNames.push(name);
      if (name === "finalize_plan") {
        return {
          toolName: name, success: true,
          data: { plan: { dayPlans: makeDayPlans() }, breakdown: makeBudget(), withinBudget: true },
        };
      }
      return {
        toolName: name, success: true,
        data: name === "search_attractions"
          ? { items: [{ name: "故宫" } as any], scores: { "故宫": 0.9 } }
          : {},
      };
    });
    const deps: LoopDeps = {
      llmCaller: caller,
      schemaLookup: emptySchemaLookup(),
      toolExecutor: executor,
    };

    const result = await runAgentLoop("test-sid-007", planningState, [], "go", deps);
    expect(executedNames.sort()).toEqual(["finalize_plan", "search_attractions"]);
    expect(result.state.candidateAttractions?.length).toBe(1);
    expect(result.state.budgetBreakdown).toBeDefined();
    expect(result.iterations).toBe(1);
  });
});

describe("runAgentLoop - overflow", () => {
  it("throws AgentLoopOverflowError when MAX_ITERATIONS exceeded", async () => {
    const state = makeState({ phase: "gathering" });
    const foreverResponse: LLMResponse = {
      stopReason: "tool_use",
      text: "",
      toolCalls: [{ name: "collect_preferences", input: {} }],
    };
    const caller = makeMockCaller(Array(MAX_ITERATIONS + 5).fill(foreverResponse));
    const deps: LoopDeps = {
      llmCaller: caller,
      schemaLookup: emptySchemaLookup(),
      toolExecutor: makeMockExecutor((name) => ({
        toolName: name, success: true,
        data: { destination: "x", departureCity: "y", startDate: "2026-07-01", endDate: "2026-07-02", numTravelers: 1, budget: 1000 },
      })),
    };

    await expect(runAgentLoop("test-sid-008", state, [], "go", deps))
      .rejects.toThrow(AgentLoopOverflowError);
  }, 15000);
});

describe("runAgentLoop - message history threading", () => {
  it("preserves initial messages and appends user/assistant/tool pairs", async () => {
    const completedState = makeState({
      phase: "completed",
      preferences: makePrefs(),
      dayPlans: makeDayPlans(),
      budgetBreakdown: makeBudget(),
    });
    const caller = makeMockCaller([
      { stopReason: "end_turn", text: "ok", toolCalls: [] },
    ]);
    const deps: LoopDeps = {
      llmCaller: caller,
      schemaLookup: emptySchemaLookup(),
      toolExecutor: makeMockExecutor(() => ({ toolName: "", success: true, data: {} })),
    };

    const result = await runAgentLoop(
      "test-sid-009",
      completedState,
      [{ role: "user", content: "previous context" }],
      "new user message",
      deps,
    );
    expect(result.messages[0]).toEqual({ role: "user", content: "previous context" });
    expect(result.messages[1]).toEqual({ role: "user", content: "new user message" });
    expect(result.messages[2]).toEqual(expect.objectContaining({ role: "assistant" }));
  });
});

describe("runAgentLoop - SSE emit", () => {
  it("emits llm_request and llm_response events", async () => {
    const completedState = makeState({
      phase: "completed",
      preferences: makePrefs(),
      dayPlans: makeDayPlans(),
      budgetBreakdown: makeBudget(),
    });
    const events: any[] = [];
    const caller = makeMockCaller([
      { stopReason: "end_turn", text: "ok", toolCalls: [] },
    ]);
    const deps: LoopDeps = {
      llmCaller: caller,
      schemaLookup: emptySchemaLookup(),
      toolExecutor: makeMockExecutor(() => ({ toolName: "", success: true, data: {} })),
      emit: { emit: (e) => events.push(e) },
    };

    await runAgentLoop("test-sid-010", completedState, [], "go", deps);
    expect(events.map(e => e.type)).toEqual(["llm_request", "llm_response"]);
  });

  it("emits tools_executed event when tools run", async () => {
    const planningState = makeState({
      phase: "planning",
      preferences: makePrefs(),
      selectedOutbound: { id: "X" } as any,
      selectedReturn: { id: "Y" } as any,
      selectedHotel: { name: "H" } as any,
    });
    const events: any[] = [];
    const caller = makeMockCaller([
      { stopReason: "tool_use", text: "", toolCalls: [
        { id: "tu1", name: "search_attractions", input: {} },
        { id: "tu2", name: "finalize_plan", input: { rawJson: "{}" } },
      ]},
    ]);
    const deps: LoopDeps = {
      llmCaller: caller,
      schemaLookup: emptySchemaLookup(),
      toolExecutor: makeMockExecutor((name) => ({
        toolName: name, success: true,
        data: name === "finalize_plan"
          ? { plan: { dayPlans: makeDayPlans() }, breakdown: makeBudget(), withinBudget: true }
          : { items: [{ name: "故宫" } as any], scores: {} },
      })),
      emit: { emit: (e) => events.push(e) },
    };

    await runAgentLoop("test-sid-011", planningState, [], "go", deps);
    const toolEvents = events.filter(e => e.type === "tools_executed");
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0].count).toBe(2);
    expect(toolEvents[0].failures).toBe(0);
  });
});

describe("runAgentLoop - budget loop integration", () => {
  it("reverts to planning on over-budget finalize_plan, second call within budget finishes", async () => {
    const planningState = makeState({
      phase: "planning",
      preferences: makePrefs(),
      selectedOutbound: { id: "X" } as any,
      selectedReturn: { id: "Y" } as any,
      selectedHotel: { name: "H" } as any,
    });
    const overBudget = makeBudget({ totalCost: 20000, isWithinBudget: false, variance: 5000 });
    const withinBudget = makeBudget();
    const caller = makeMockCaller([
      { stopReason: "tool_use", text: "", toolCalls: [
        { id: "tu1", name: "finalize_plan", input: { rawJson: "{}" } },
      ]},
      { stopReason: "tool_use", text: "", toolCalls: [
        { id: "tu2", name: "finalize_plan", input: { rawJson: "{}" } },
      ]},
    ]);
    let finalizeCallCount = 0;
    const executor = makeMockExecutor((name) => {
      if (name === "finalize_plan") {
        finalizeCallCount++;
        const breakdown = finalizeCallCount === 1 ? overBudget : withinBudget;
        return {
          toolName: name, success: true,
          data: { plan: { dayPlans: makeDayPlans() }, breakdown, withinBudget: breakdown.isWithinBudget },
        };
      }
      return { toolName: name, success: true, data: {} };
    });
    const deps: LoopDeps = {
      llmCaller: caller,
      schemaLookup: emptySchemaLookup(),
      toolExecutor: executor,
    };

    const result = await runAgentLoop("test-sid-012", planningState, [], "plan", deps);
    expect(finalizeCallCount).toBe(2);
    expect(result.state.budgetRound).toBe(1);
    expect(result.state.budgetBreakdown?.isWithinBudget).toBe(true);
    expect(result.iterations).toBe(2);
  });
});
