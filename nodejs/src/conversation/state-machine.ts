export enum ConversationState {
  INIT = "INIT",
  GATHERING_BASICS = "GATHERING_BASICS",
  GATHERING_PREFERENCES = "GATHERING_PREFERENCES",
  SEARCHING = "SEARCHING",
  COMPLETED = "COMPLETED",
  ERROR = "ERROR",
}

const TRANSITIONS: Record<ConversationState, ConversationState[]> = {
  [ConversationState.INIT]: [ConversationState.GATHERING_BASICS],
  [ConversationState.GATHERING_BASICS]: [
    ConversationState.GATHERING_BASICS,
    ConversationState.GATHERING_PREFERENCES,
  ],
  [ConversationState.GATHERING_PREFERENCES]: [
    ConversationState.GATHERING_PREFERENCES,
    ConversationState.SEARCHING,
  ],
  [ConversationState.SEARCHING]: [
    ConversationState.COMPLETED,
    ConversationState.ERROR,
  ],
  [ConversationState.COMPLETED]: [],
  [ConversationState.ERROR]: [
    ConversationState.GATHERING_BASICS,
    ConversationState.GATHERING_PREFERENCES,
    ConversationState.SEARCHING,
  ],
};

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

  const preferencesComplete =
    ctx.budget != null &&
    ctx.accommodationStyle &&
    ctx.travelInterests?.length;

  if (preferencesComplete || ctx.turnCount >= maxGatheringTurns) {
    return ConversationState.SEARCHING;
  }

  return ConversationState.GATHERING_PREFERENCES;
}
