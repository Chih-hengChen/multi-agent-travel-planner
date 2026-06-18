import type { AgentState, Phase } from "./state.js";
import { listToolsForPhase } from "../tools/policy.js";

const BASE_PROMPT = `你是一个旅行规划 Agent,通过工具调用完成多阶段任务。

【ReAct 推理要求】
在每次决策前,你必须先用 <thought>...</thought> 块输出推理,内容包括:
1. 当前 phase 与已有信息(1 句)
2. 下一步要做什么、为什么(1-2 句)
3. 拟调用的工具与关键参数

示例:
<thought>
phase=searching, 已有目的地东京。下一步需要并行获取景点/酒店/小红书真实评价。
</thought>

【并行调用】
当需要检索多个独立信息源(景点/酒店/小红书/百科),请一次性并行调用所有相关工具,而非逐个。

【JSON 输出】
finalize_plan 工具的 rawJson 字段必须是合法 JSON,不要省略花括号或逗号。

【约束】
- 不要在 gathering 阶段调用 search_*
- 不要在 planning 阶段调用 collect_preferences
- 同一轮内不要用相同参数重复调用同一工具`;

const PHASE_PROMPTS: Record<Phase, string> = {
  gathering:  `【当前阶段:gathering(收集偏好)】
任务:通过 collect_preferences 工具获取用户的 destination / departureCity / startDate / endDate / numTravelers / budget。
下一阶段:必填字段齐全 → searching(自动)。`,

  searching:  `【当前阶段:searching(并行检索)】
任务:并行调用 search_baike / search_attractions / search_hotels / search_xhs / search_restaurants(scope=city)。
约束:
- 高德 API 全局限流 3 QPS(代码层排队)
- search_xhs 默认 30 篇,不够再爬 30
- search_restaurants 用 scope=city(城市热门),不要 scope=attraction
下一阶段:候选齐全 → selecting。`,

  selecting:  `【当前阶段:selecting(用户选择)】
任务:推送交通候选(去程+返程)和酒店候选,等待用户用 select_transport / select_hotel 工具确认。
下一阶段:三个 selected 字段齐全 → planning。`,

  planning:   `【当前阶段:planning(行程编排)】
任务:为每一天编排景点 + 衔接交通 + 餐厅。最后调 finalize_plan 输出完整 JSON。
约束:
- 景点→景点之间用 plan_transit 工具
- search_restaurants 用 scope=attraction + near=<景点名>
- 餐厅多样性:本地特色 ≤60%、排除连锁(除非用户显式)
- finalize_plan 失败 → planning,budgetRound+1,最多重试 3 次`,

  completed:  `【当前阶段:completed】
行程已交付,等待用户反馈或新指令。`,
};

export function stateSummary(state: AgentState): string {
  const lines: string[] = [];
  if (state.preferences) {
    const p = state.preferences;
    lines.push(`目的地:${p.preferredDestination ?? "(待填)"}, 出发地:${p.departureCity ?? "(待填)"}`);
    lines.push(`日期:${p.startDate ?? "?"} ~ ${p.endDate ?? "?"}, 人数:${p.numTravelers ?? "?"}, 预算:¥${p.budget ?? "?"}`);
  }
  if (state.baikeKnowledge) lines.push(`百科:已知`);
  if (state.candidateAttractions?.length) lines.push(`候选景点:${state.candidateAttractions.length} 个`);
  if (state.candidateHotels?.length) lines.push(`候选酒店:${state.candidateHotels.length} 家`);
  if (state.candidateRestaurants?.length) lines.push(`候选餐厅(城市级):${state.candidateRestaurants.length} 家`);
  if (state.xhsNotes?.length) lines.push(`XHS 笔记:${state.xhsNotes.length} 篇`);
  if (state.selectedOutbound) lines.push(`已选去程:${(state.selectedOutbound as { flightNo?: string; trainNo?: string }).flightNo ?? (state.selectedOutbound as { trainNo?: string }).trainNo ?? "?"}`);
  if (state.selectedReturn) lines.push(`已选返程:${(state.selectedReturn as { flightNo?: string; trainNo?: string }).flightNo ?? (state.selectedReturn as { trainNo?: string }).trainNo ?? "?"}`);
  if (state.selectedHotel) lines.push(`已选酒店:${(state.selectedHotel as { name?: string }).name ?? "?"}`);
  if (state.dayPlans?.length) lines.push(`已编排:${state.dayPlans.length} 天`);
  if (state.budgetBreakdown) lines.push(`预算:${state.budgetBreakdown.totalCost}/${state.budgetBreakdown.budgetLimit}(${state.budgetBreakdown.isWithinBudget ? "内" : "超"})`);
  if (state.budgetRound > 0) lines.push(`budgetRound:${state.budgetRound}`);
  if (state.errorMessages.length) lines.push(`错误:${state.errorMessages.length} 条`);
  return lines.join("\n") || "(state 为空)";
}

export function buildSystemPrompt(state: AgentState): string {
  const tools = listToolsForPhase(state.phase);
  return [
    BASE_PROMPT, "",
    PHASE_PROMPTS[state.phase], "",
    "【当前 state 摘要】",
    stateSummary(state),
    "",
    "【可用工具(本 phase)】",
    tools.length > 0
      ? tools.map(t => `- ${t.name}: ${t.description}`).join("\n")
      : "(无)",
  ].join("\n");
}
