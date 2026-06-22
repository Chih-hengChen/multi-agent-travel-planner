export enum ConversationState {
  INIT = "INIT",
  GATHERING_BASICS = "GATHERING_BASICS",
  GATHERING_PREFERENCES = "GATHERING_PREFERENCES",
  SEARCHING_TRANSPORT = "SEARCHING_TRANSPORT",
  SELECTING_TRANSPORT = "SELECTING_TRANSPORT",
  SEARCHING_HOTELS = "SEARCHING_HOTELS",
  SELECTING_HOTEL = "SELECTING_HOTEL",
  SEARCHING = "SEARCHING",
  COMPLETED = "COMPLETED",
  ERROR_RECOVERABLE = "ERROR_RECOVERABLE",
  ERROR_TERMINAL = "ERROR_TERMINAL",
}

export type RecoveryPolicy =
  | "retry_same"
  | "retry_with_relaxed_constraints"
  | "fallback_source"
  | "ask_user"
  | "skip_optional_step"
  | "rollback_to_state"
  | "terminal_error";

export type ErrorType =
  | "validation_error"
  | "tool_timeout"
  | "tool_empty_result"
  | "tool_auth_error"
  | "tool_rate_limit"
  | "llm_parse_error"
  | "low_confidence"
  | "user_input_missing";

export interface StateSpec {
  name: ConversationState;
  requiredFields: string[];
  exitCriteria: string[];
  allowedTransitions: ConversationState[];
  recoveryPolicy: RecoveryPolicy;
  requiresHumanConfirmation: boolean;
}

export const STATE_SPECS: Record<ConversationState, StateSpec> = {
  [ConversationState.INIT]: {
    name: ConversationState.INIT,
    requiredFields: [],
    exitCriteria: ["有目的地或旅行相关消息"],
    allowedTransitions: [ConversationState.GATHERING_BASICS],
    recoveryPolicy: "retry_same",
    requiresHumanConfirmation: false,
  },
  [ConversationState.GATHERING_BASICS]: {
    name: ConversationState.GATHERING_BASICS,
    requiredFields: ["destination", "departureCity", "startDate", "endDate", "numTravelers"],
    exitCriteria: ["basics 字段齐全"],
    allowedTransitions: [
      ConversationState.GATHERING_BASICS,
      ConversationState.GATHERING_PREFERENCES,
    ],
    recoveryPolicy: "ask_user",
    requiresHumanConfirmation: false,
  },
  [ConversationState.GATHERING_PREFERENCES]: {
    name: ConversationState.GATHERING_PREFERENCES,
    requiredFields: ["budget", "accommodationStyle", "travelInterests"],
    exitCriteria: ["preferences 字段齐全或超过最大轮数"],
    allowedTransitions: [
      ConversationState.GATHERING_PREFERENCES,
      ConversationState.SEARCHING_TRANSPORT,
    ],
    recoveryPolicy: "ask_user",
    requiresHumanConfirmation: false,
  },
  [ConversationState.SEARCHING_TRANSPORT]: {
    name: ConversationState.SEARCHING_TRANSPORT,
    requiredFields: ["departureCity", "destination", "startDate", "endDate"],
    exitCriteria: ["去程和返程都有搜索结果"],
    allowedTransitions: [
      ConversationState.SELECTING_TRANSPORT,
      ConversationState.ERROR_RECOVERABLE,
    ],
    recoveryPolicy: "fallback_source",
    requiresHumanConfirmation: false,
  },
  [ConversationState.SELECTING_TRANSPORT]: {
    name: ConversationState.SELECTING_TRANSPORT,
    requiredFields: [],
    exitCriteria: ["用户选择了去程和返程"],
    allowedTransitions: [
      ConversationState.SEARCHING_HOTELS,
      ConversationState.SEARCHING_TRANSPORT,
    ],
    recoveryPolicy: "ask_user",
    requiresHumanConfirmation: true,
  },
  [ConversationState.SEARCHING_HOTELS]: {
    name: ConversationState.SEARCHING_HOTELS,
    requiredFields: ["destination", "startDate", "endDate"],
    exitCriteria: ["酒店搜索结果非空"],
    allowedTransitions: [
      ConversationState.SELECTING_HOTEL,
      ConversationState.ERROR_RECOVERABLE,
    ],
    recoveryPolicy: "fallback_source",
    requiresHumanConfirmation: false,
  },
  [ConversationState.SELECTING_HOTEL]: {
    name: ConversationState.SELECTING_HOTEL,
    requiredFields: [],
    exitCriteria: ["用户选择了酒店"],
    allowedTransitions: [
      ConversationState.SEARCHING,
      ConversationState.SEARCHING_HOTELS,
      ConversationState.SELECTING_TRANSPORT,
    ],
    recoveryPolicy: "ask_user",
    requiresHumanConfirmation: true,
  },
  [ConversationState.SEARCHING]: {
    name: ConversationState.SEARCHING,
    requiredFields: [],
    exitCriteria: ["pipeline 执行完毕"],
    allowedTransitions: [
      ConversationState.COMPLETED,
      ConversationState.ERROR_RECOVERABLE,
    ],
    recoveryPolicy: "retry_with_relaxed_constraints",
    requiresHumanConfirmation: false,
  },
  [ConversationState.COMPLETED]: {
    name: ConversationState.COMPLETED,
    requiredFields: [],
    exitCriteria: [],
    allowedTransitions: [],
    recoveryPolicy: "ask_user",
    requiresHumanConfirmation: false,
  },
  [ConversationState.ERROR_RECOVERABLE]: {
    name: ConversationState.ERROR_RECOVERABLE,
    requiredFields: [],
    exitCriteria: ["错误已处理，可以恢复"],
    allowedTransitions: [
      ConversationState.GATHERING_BASICS,
      ConversationState.GATHERING_PREFERENCES,
      ConversationState.SEARCHING_TRANSPORT,
      ConversationState.SEARCHING_HOTELS,
      ConversationState.SEARCHING,
    ],
    recoveryPolicy: "retry_same",
    requiresHumanConfirmation: false,
  },
  [ConversationState.ERROR_TERMINAL]: {
    name: ConversationState.ERROR_TERMINAL,
    requiredFields: [],
    exitCriteria: [],
    allowedTransitions: [ConversationState.INIT],
    recoveryPolicy: "terminal_error",
    requiresHumanConfirmation: false,
  },
};

const TRANSITIONS: Record<ConversationState, ConversationState[]> = Object.fromEntries(
  Object.entries(STATE_SPECS).map(([key, spec]) => [key, spec.allowedTransitions]),
) as Record<ConversationState, ConversationState[]>;

export function canTransition(
  from: ConversationState,
  to: ConversationState,
): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export interface FieldContext {
  destination?: string;
  departureCity?: string;
  startDate?: string;
  endDate?: string;
  numTravelers?: number;
  budget?: number;
  accommodationStyle?: string;
  travelInterests?: string[];
  mustVisitAttractions?: string[];
  transportPreference?: string;
  outboundTransportPreference?: string;
  returnTransportPreference?: string;
  turnCount: number;
}

export function advanceState(
  ctx: FieldContext,
  maxGatheringTurns: number,
): ConversationState {
  const { destination, departureCity, startDate, endDate, numTravelers } = ctx;

  if (!destination) return ConversationState.INIT;

  const basicsComplete =
    departureCity && startDate && endDate && numTravelers != null;

  if (!basicsComplete) return ConversationState.GATHERING_BASICS;

  const hasTransportPref = ctx.transportPreference
    || ctx.outboundTransportPreference
    || ctx.returnTransportPreference;
  const hasTravelHints = (ctx.travelInterests?.length ?? 0) > 0
    || (ctx.mustVisitAttractions?.length ?? 0) > 0;
  const preferencesComplete =
    ctx.budget != null &&
    ctx.accommodationStyle != null &&
    hasTravelHints &&
    hasTransportPref;

  if (preferencesComplete || ctx.turnCount >= maxGatheringTurns) {
    return ConversationState.SEARCHING_TRANSPORT;
  }

  return ConversationState.GATHERING_PREFERENCES;
}
