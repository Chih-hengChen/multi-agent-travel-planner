import { describe, it, expect } from "vitest";
import { buildSystemPrompt, stateSummary } from "../system-prompt.js";
import type { AgentState } from "../state.js";

function makeState(over: Partial<AgentState> = {}): AgentState {
  return {
    phase: "gathering",
    iteration: 0,
    budgetRound: 0,
    priceWarnings: [],
    errorMessages: [],
    toolErrors: {},
    rerankScores: {},
    fallbackUsage: {},
    ...over,
  };
}

describe("stateSummary", () => {
  it("returns placeholder for empty state", () => {
    expect(stateSummary(makeState())).toBe("(state 为空)");
  });

  it("includes preferences when set", () => {
    const s = makeState({
      preferences: { preferredDestination: "东京", departureCity: "北京", startDate: "2026-07-01", endDate: "2026-07-02", numTravelers: 2, budget: 15000 } as any,
    });
    const summary = stateSummary(s);
    expect(summary).toContain("东京");
    expect(summary).toContain("北京");
    expect(summary).toContain("15000");
  });

  it("includes candidate counts", () => {
    const s = makeState({
      candidateAttractions: [{ name: "A" }] as any,
      candidateHotels: [{ name: "H" }] as any,
      xhsNotes: [{ noteId: "1" }] as any,
    });
    const summary = stateSummary(s);
    expect(summary).toContain("候选景点:1 个");
    expect(summary).toContain("候选酒店:1 家");
    expect(summary).toContain("XHS 笔记:1 篇");
  });

  it("includes selections and budget", () => {
    const s = makeState({
      selectedOutbound: { flightNo: "CA123" } as any,
      selectedHotel: { name: "Mystays" } as any,
      dayPlans: [{ dayIdx: 0, date: "2026-07-01", dining: [], transitTips: [] }],
      budgetBreakdown: { totalCost: 10000, budgetLimit: 15000, isWithinBudget: true } as any,
      errorMessages: ["test error"],
    });
    const summary = stateSummary(s);
    expect(summary).toContain("CA123");
    expect(summary).toContain("Mystays");
    expect(summary).toContain("已编排:1 天");
    expect(summary).toContain("15000");
    expect(summary).toContain("错误:1 条");
  });
});

describe("buildSystemPrompt", () => {
  it("gathering prompt contains correct phase", () => {
    const prompt = buildSystemPrompt(makeState({ phase: "gathering" }));
    expect(prompt).toContain("【当前阶段:gathering");
    expect(prompt).toContain("collect_preferences");
    expect(prompt).toContain("ReAct 推理要求");
    expect(prompt).toContain("【可用工具(本 phase)】");
  });

  it("searching prompt lists search tools", () => {
    const prompt = buildSystemPrompt(makeState({ phase: "searching" }));
    expect(prompt).toContain("【当前阶段:searching");
    expect(prompt).toContain("search_baike");
    expect(prompt).toContain("search_attractions");
    expect(prompt).toContain("search_xhs");
    expect(prompt).toContain("3 QPS");
  });

  it("selecting prompt encourages user choice", () => {
    const prompt = buildSystemPrompt(makeState({ phase: "selecting" }));
    expect(prompt).toContain("【当前阶段:selecting");
    expect(prompt).toContain("select_transport");
    expect(prompt).toContain("select_hotel");
  });

  it("planning prompt mentions transit and restaurants", () => {
    const s = makeState({ phase: "planning" });
    const prompt = buildSystemPrompt(s);
    expect(prompt).toContain("【当前阶段:planning");
    expect(prompt).toContain("plan_transit");
    expect(prompt).toContain("finalize_plan");
    expect(prompt).toContain("本地特色");
  });

  it("completed prompt is minimal", () => {
    const prompt = buildSystemPrompt(makeState({ phase: "completed" }));
    expect(prompt).toContain("【当前阶段:completed");
    expect(prompt).toContain("(无)");
  });

  it("includes state summary section", () => {
    const s = makeState({ phase: "searching", baikeKnowledge: "Tokyo info" });
    const prompt = buildSystemPrompt(s);
    expect(prompt).toContain("【当前 state 摘要】");
    expect(prompt).toContain("百科");
  });
});
