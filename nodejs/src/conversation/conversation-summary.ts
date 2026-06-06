import type { ConversationContext } from "./context.js";

export interface ConversationSummary {
  confirmedFacts: string[];
  userPreferences: string[];
  unresolvedQuestions: string[];
  rejectedOptions: string[];
  lastDecision: string;
}

const MAX_HISTORY_WITHOUT_SUMMARY = 10;

export function needsSummary(ctx: ConversationContext): boolean {
  return ctx.messageHistory.length > MAX_HISTORY_WITHOUT_SUMMARY;
}

export function buildStructuredState(ctx: ConversationContext): string {
  const lines: string[] = ["=== 当前业务状态 ==="];
  lines.push(`状态: ${ctx.state}`);
  lines.push(`目的地: ${ctx.destination ?? "未指定"}`);
  lines.push(`出发城市: ${ctx.departureCity ?? "未指定"}`);
  lines.push(`出发日期: ${ctx.startDate ?? "未指定"}`);
  lines.push(`返回日期: ${ctx.endDate ?? "未指定"}`);
  lines.push(`人数: ${ctx.numTravelers ?? "未指定"}`);
  lines.push(`预算: ${ctx.budget ? `${ctx.budget}元` : "未指定"}`);
  lines.push(`住宿风格: ${ctx.accommodationStyle ?? "未指定"}`);
  lines.push(`去程偏好: ${ctx.outboundTransportPreference ?? "未指定"}`);
  lines.push(`返程偏好: ${ctx.returnTransportPreference ?? "未指定"}`);

  if (ctx.mustVisitAttractions?.length) {
    lines.push(`必去景点: ${ctx.mustVisitAttractions.join("、")}`);
  }
  if (ctx.travelInterests?.length) {
    lines.push(`兴趣: ${ctx.travelInterests.join("、")}`);
  }
  if (ctx.selectedOutboundId) {
    lines.push(`已选去程: ${ctx.selectedOutboundId}`);
  }
  if (ctx.selectedReturnId) {
    lines.push(`已选返程: ${ctx.selectedReturnId}`);
  }
  if (ctx.selectedHotel?.name) {
    lines.push(`已选酒店: ${ctx.selectedHotel.name}`);
  }

  return lines.join("\n");
}

export function buildSummary(ctx: ConversationContext): ConversationSummary {
  const confirmedFacts: string[] = [];
  const userPreferences: string[] = [];
  const rejectedOptions: string[] = [];
  const unresolvedQuestions: string[] = [];

  if (ctx.destination) confirmedFacts.push(`目的地: ${ctx.destination}`);
  if (ctx.departureCity) confirmedFacts.push(`出发城市: ${ctx.departureCity}`);
  if (ctx.startDate) confirmedFacts.push(`出发日期: ${ctx.startDate}`);
  if (ctx.endDate) confirmedFacts.push(`返回日期: ${ctx.endDate}`);
  if (ctx.numTravelers) confirmedFacts.push(`人数: ${ctx.numTravelers}`);
  if (ctx.budget) confirmedFacts.push(`预算: ${ctx.budget}元`);

  if (ctx.accommodationStyle) userPreferences.push(`住宿: ${ctx.accommodationStyle}`);
  if (ctx.travelInterests?.length) userPreferences.push(`兴趣: ${ctx.travelInterests.join("、")}`);
  if (ctx.outboundTransportPreference) userPreferences.push(`去程偏好: ${ctx.outboundTransportPreference}`);
  if (ctx.returnTransportPreference) userPreferences.push(`返程偏好: ${ctx.returnTransportPreference}`);
  if (ctx.mustVisitAttractions?.length) userPreferences.push(`必去景点: ${ctx.mustVisitAttractions.join("、")}`);

  const lastDecision =
    ctx.selectedHotel?.name
      ? `选择了酒店: ${ctx.selectedHotel.name}`
      : ctx.selectedOutboundId
        ? `选择了去程: ${ctx.selectedOutboundId}`
        : ctx.pendingQuestion
          ? `正在询问: ${ctx.pendingQuestion.slice(0, 50)}`
          : "等待用户输入";

  return {
    confirmedFacts,
    userPreferences,
    unresolvedQuestions,
    rejectedOptions,
    lastDecision,
  };
}

export function formatSummaryForPrompt(summary: ConversationSummary): string {
  const parts: string[] = [];

  if (summary.confirmedFacts.length > 0) {
    parts.push("=== 已确认信息 ===");
    parts.push(summary.confirmedFacts.join("\n"));
  }

  if (summary.userPreferences.length > 0) {
    parts.push("=== 用户偏好 ===");
    parts.push(summary.userPreferences.join("\n"));
  }

  if (summary.rejectedOptions.length > 0) {
    parts.push("=== 用户拒绝 ===");
    parts.push(summary.rejectedOptions.join("\n"));
  }

  if (summary.lastDecision) {
    parts.push(`=== 上一步决策 ===\n${summary.lastDecision}`);
  }

  return parts.join("\n\n");
}
