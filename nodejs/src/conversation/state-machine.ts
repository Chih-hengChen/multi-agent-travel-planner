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
    ConversationState.SEARCHING_TRANSPORT,
  ],
  [ConversationState.SEARCHING_TRANSPORT]: [
    ConversationState.SELECTING_TRANSPORT,
    ConversationState.ERROR,
  ],
  [ConversationState.SELECTING_TRANSPORT]: [
    ConversationState.SEARCHING_HOTELS,
    ConversationState.SEARCHING_TRANSPORT,
  ],
  [ConversationState.SEARCHING_HOTELS]: [
    ConversationState.SELECTING_HOTEL,
    ConversationState.ERROR,
  ],
  [ConversationState.SELECTING_HOTEL]: [
    ConversationState.SEARCHING,
    ConversationState.SEARCHING_HOTELS,
    ConversationState.SELECTING_TRANSPORT,
  ],
  [ConversationState.SEARCHING]: [
    ConversationState.COMPLETED,
    ConversationState.ERROR,
  ],
  [ConversationState.COMPLETED]: [],
  [ConversationState.ERROR]: [
    ConversationState.GATHERING_BASICS,
    ConversationState.GATHERING_PREFERENCES,
    ConversationState.SEARCHING_TRANSPORT,
    ConversationState.SEARCHING_HOTELS,
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
  transportPreference?: string;
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
    ctx.travelInterests?.length &&
    ctx.transportPreference;

  if (preferencesComplete || ctx.turnCount >= maxGatheringTurns) {
    return ConversationState.SEARCHING_TRANSPORT;
  }

  return ConversationState.GATHERING_PREFERENCES;
}
