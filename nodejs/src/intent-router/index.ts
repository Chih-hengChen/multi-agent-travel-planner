import type { RouteDecision } from "./types.js";
import { ConversationState } from "../conversation/state-machine.js";

const TRAVEL_KEYWORDS = [
  "旅行", "旅游", "游玩", "去", "到", "出发", "行程",
  "规划", "安排", "攻略", "自由行", "跟团",
];

const GREETING_PATTERNS = [
  /^(你好|您好|嗨|hi|hello|hey|哈[喽罗]|早上好|晚上好|下午好)\s*$/i,
  /^(在吗|在不在|有人吗)\s*$/i,
];

const QUESTION_WORDS = ["什么", "怎么", "如何", "为什么", "有没有", "是否", "吗"];

function hasAnyKeyword(text: string, keywords: string[]): boolean {
  return keywords.some((k) => text.includes(k));
}

function extractRequiredFields(text: string, currentState: Record<string, unknown>): string[] {
  const missing: string[] = [];

  if (!currentState.destination && !hasAnyKeyword(text, ["去", "到", "目的地", "玩"])) {
    missing.push("destination");
  }
  if (!currentState.departureCity && !hasAnyKeyword(text, ["从", "出发"])) {
    missing.push("departureCity");
  }
  if (!currentState.startDate) {
    missing.push("startDate");
  }
  if (!currentState.endDate) {
    missing.push("endDate");
  }
  if (!currentState.numTravelers) {
    missing.push("numTravelers");
  }
  if (!currentState.budget) {
    missing.push("budget");
  }

  return missing;
}

function detectIntent(text: string, currentState: Record<string, unknown>): RouteDecision {
  const trimmed = text.trim();

  if (GREETING_PATTERNS.some((p) => p.test(trimmed)) || trimmed.length <= 2) {
    return {
      intent: "simple_answer",
      executionMode: "simple_llm",
      confidence: 0.95,
      reason: "用户问候或简短消息，不需要旅行规划",
      requiredFields: [],
      humanCheckpoints: [],
    };
  }

  const hasQuestionWord = QUESTION_WORDS.some((w) => text.includes(w));
  const hasTravelIntent = hasAnyKeyword(text, TRAVEL_KEYWORDS);
  if (hasQuestionWord && !hasTravelIntent && text.length < 20) {
    return {
      intent: "simple_answer",
      executionMode: "simple_llm",
      confidence: 0.8,
      reason: "普通提问，不涉及旅行规划",
      requiredFields: [],
      humanCheckpoints: [],
    };
  }

  if (hasTravelIntent) {
    const missing = extractRequiredFields(text, currentState);
    const hasAllBasics =
      missing.length === 0 ||
      missing.every((f) => !["destination", "departureCity", "startDate", "endDate", "budget"].includes(f));

    if (hasAllBasics) {
      return {
        intent: "deterministic_workflow",
        executionMode: "workflow",
        confidence: 0.9,
        reason: "用户提供了完整旅行信息，直接进入工作流",
        requiredFields: [],
        humanCheckpoints: ["transport_selection", "hotel_selection"],
      };
    }

    return {
      intent: "slot_filling",
      executionMode: "multi_agent",
      confidence: 0.85,
      reason: "用户有旅行意图但信息不完整，需要收集字段",
      requiredFields: missing,
      humanCheckpoints: [],
    };
  }

  if (
    currentState.state === ConversationState.SELECTING_TRANSPORT ||
    currentState.state === ConversationState.SELECTING_HOTEL
  ) {
    return {
      intent: "human_confirmation",
      executionMode: "human_confirm",
      confidence: 0.9,
      reason: "用户当前在选择状态，需要等待选择操作",
      requiredFields: [],
      humanCheckpoints: ["transport_selection", "hotel_selection"],
    };
  }

  return {
    intent: "simple_answer",
    executionMode: "simple_llm",
    confidence: 0.5,
    reason: "无法明确判断意图，按普通回复处理",
    requiredFields: [],
    humanCheckpoints: [],
  };
}

export class IntentRouter {
  route(
    userMessage: string,
    currentState: Record<string, unknown>,
  ): RouteDecision {
    return detectIntent(userMessage, currentState);
  }
}

export type { RouteDecision, Intent, ExecutionMode } from "./types.js";
