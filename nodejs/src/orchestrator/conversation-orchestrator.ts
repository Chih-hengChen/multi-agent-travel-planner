import crypto from "node:crypto";
import type { SessionStore } from "../conversation/session-store.js";
import type { TurnHandler, TurnResult, SelectRequest } from "../conversation/turn-handler.js";
import {
  type ConversationContext,
  createDefaultContext,
} from "../conversation/context.js";
import { ConversationState } from "../conversation/state-machine.js";

export class ConversationOrchestrator {
  private readonly sessionStore: SessionStore;
  private readonly turnHandler: TurnHandler;

  constructor(sessionStore: SessionStore, turnHandler: TurnHandler) {
    this.sessionStore = sessionStore;
    this.turnHandler = turnHandler;
  }

  async createSession(): Promise<string> {
    const sessionId = crypto.randomUUID();
    const ctx = createDefaultContext(sessionId);
    await this.sessionStore.set(sessionId, ctx);
    return sessionId;
  }

  async handleMessage(
    sessionId: string,
    userMessage: string,
    emit: (event: string, data: unknown) => void,
  ): Promise<void> {
    const ctx = await this.sessionStore.get(sessionId);
    if (!ctx) {
      emit("error", { error: "Session not found", recoverable: false });
      return;
    }

    const result: TurnResult = await this.turnHandler.handleTurn(ctx, userMessage);

    if (result.newState !== ctx.state) {
      emit("state_change", { state: result.newState });
    }

    if (result.replyText) {
      emit("text_delta", { text: result.replyText });
    }

    if (result.questionFields?.length) {
      emit("question", {
        text: result.replyText,
        fields: result.questionFields,
      });
    }

    if (result.transportOptions) {
      emit("transport_options", result.transportOptions);
    }

    if (result.hotelOptions) {
      emit("hotel_options", result.hotelOptions);
    }

    if (result.planResult) {
      emit("tool_result", { tool: "plan_travel", result: result.planResult });
    }

    if (result.error) {
      emit("error", { error: result.error, recoverable: true });
    }

    ctx.state = result.newState;
    ctx.version++;
    ctx.updatedAt = Date.now();
    await this.sessionStore.set(sessionId, ctx);
    await this.sessionStore.refreshTtl(sessionId);
  }

  async handleSelect(
    sessionId: string,
    request: SelectRequest,
    emit: (event: string, data: unknown) => void,
  ): Promise<void> {
    const ctx = await this.sessionStore.get(sessionId);
    if (!ctx) {
      emit("error", { error: "Session not found", recoverable: false });
      return;
    }

    const result: TurnResult = await this.turnHandler.handleSelect(ctx, request);

    if (result.newState !== ctx.state) {
      emit("state_change", { state: result.newState });
    }

    if (result.replyText) {
      emit("text_delta", { text: result.replyText });
    }

    if (result.transportOptions) {
      emit("transport_options", result.transportOptions);
    }

    if (result.hotelOptions) {
      emit("hotel_options", result.hotelOptions);
    }

    if (result.planResult) {
      emit("tool_result", { tool: "plan_travel", result: result.planResult });
    }

    if (result.error) {
      emit("error", { error: result.error, recoverable: true });
    }

    ctx.state = result.newState;
    ctx.version++;
    ctx.updatedAt = Date.now();
    await this.sessionStore.set(sessionId, ctx);
    await this.sessionStore.refreshTtl(sessionId);
  }

  async getSessionState(
    sessionId: string,
  ): Promise<Pick<ConversationContext, "sessionId" | "state" | "turnCount" | "destination" | "departureCity" | "startDate" | "endDate" | "numTravelers" | "budget" | "accommodationStyle" | "travelInterests"> | null> {
    const ctx = await this.sessionStore.get(sessionId);
    if (!ctx) return null;
    return {
      sessionId: ctx.sessionId,
      state: ctx.state,
      turnCount: ctx.turnCount,
      destination: ctx.destination,
      departureCity: ctx.departureCity,
      startDate: ctx.startDate,
      endDate: ctx.endDate,
      numTravelers: ctx.numTravelers,
      budget: ctx.budget,
      accommodationStyle: ctx.accommodationStyle,
      travelInterests: ctx.travelInterests,
    };
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.sessionStore.delete(sessionId);
  }
}
