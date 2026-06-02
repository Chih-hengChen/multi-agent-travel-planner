import pino, { type Logger } from "pino";
import { ConversationState, advanceState } from "./state-machine.js";
import {
  type ConversationContext,
  type ExtractedFields,
  mergeExtracted,
  toUserPreferences,
  buildPlanSummary,
  isReadyForPipeline,
} from "./context.js";
import { InfoExtractor } from "./info-extractor.js";
import { GatheringAgent } from "../agents/gathering-agent.js";
import { TravelPlanningPipeline } from "../orchestrator/pipeline.js";
import { settings } from "../config/settings.js";
import type { PlanSummary } from "../types/index.js";

export interface TurnResult {
  newState: ConversationState;
  replyText: string;
  questionFields?: string[];
  planResult?: PlanSummary;
  error?: string;
}

export class TurnHandler {
  private readonly infoExtractor: InfoExtractor;
  private readonly gatheringAgent: GatheringAgent;
  private readonly pipeline: TravelPlanningPipeline;
  private readonly log: Logger;

  constructor(
    infoExtractor: InfoExtractor,
    gatheringAgent: GatheringAgent,
    pipeline: TravelPlanningPipeline,
    log?: Logger,
  ) {
    this.infoExtractor = infoExtractor;
    this.gatheringAgent = gatheringAgent;
    this.pipeline = pipeline;
    this.log = log ?? pino({ level: settings.LOG_LEVEL });
  }

  async handleTurn(
    ctx: ConversationContext,
    userMessage: string,
  ): Promise<TurnResult> {
    ctx.messageHistory.push({ role: "user", content: userMessage });
    ctx.turnCount++;

    if (ctx.state === ConversationState.ERROR && ctx.lastError) {
      if (ctx.lastError.retryCount < 2) {
        this.log.info({ sessionId: ctx.sessionId }, "Retrying from ERROR state");
        ctx.lastError.retryCount++;
      } else {
        return {
          newState: ConversationState.ERROR,
          replyText: "抱歉，系统暂时无法处理您的请求，请稍后再试。",
          error: "Max retries exceeded",
        };
      }
    }

    const knownFields = this.getKnownFields(ctx);
    let extracted: ExtractedFields;
    try {
      extracted = await this.infoExtractor.extract(
        userMessage,
        ctx.messageHistory.slice(0, -1),
        knownFields,
      );
    } catch (err) {
      this.log.warn({ err }, "InfoExtractor failed, continuing with empty extraction");
      extracted = {};
    }

    if (Object.keys(extracted).length > 0) {
      Object.assign(ctx, mergeExtracted(ctx, extracted));
    }

    const newState = advanceState(ctx, settings.MAX_GATHERING_TURNS);

    if (
      newState === ConversationState.SEARCHING ||
      (newState === ConversationState.GATHERING_PREFERENCES && isReadyForPipeline(ctx))
    ) {
      return this.runPipeline(ctx);
    }

    ctx.state = newState;

    if (
      newState === ConversationState.GATHERING_BASICS ||
      newState === ConversationState.GATHERING_PREFERENCES ||
      newState === ConversationState.INIT
    ) {
      const question = await this.gatheringAgent.generateQuestion(ctx);
      if (question.text) {
        ctx.messageHistory.push({ role: "assistant", content: question.text });
        ctx.pendingQuestion = question.text;
        ctx.updatedAt = Date.now();
        return {
          newState: ctx.state,
          replyText: question.text,
          questionFields: question.fields,
        };
      }
    }

    return {
      newState: ctx.state,
      replyText: "好的，我已记录您的信息。请问还有需要补充的吗？",
    };
  }

  private async runPipeline(ctx: ConversationContext): Promise<TurnResult> {
    ctx.state = ConversationState.SEARCHING;
    ctx.updatedAt = Date.now();

    const introText = `好的，我已收到您的信息。正在为您规划${ctx.destination ?? ""}的旅行方案，请稍候...`;

    try {
      const prefs = toUserPreferences(ctx);
      const state = await this.pipeline.run(prefs);
      const planResult = buildPlanSummary(state);

      ctx.state = ConversationState.COMPLETED;
      ctx.updatedAt = Date.now();

      return {
        newState: ConversationState.COMPLETED,
        replyText: introText,
        planResult,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error({ err: msg, sessionId: ctx.sessionId }, "Pipeline failed");

      ctx.state = ConversationState.ERROR;
      ctx.lastError = {
        state: ConversationState.SEARCHING,
        message: msg,
        retryCount: 0,
        timestamp: Date.now(),
      };
      ctx.updatedAt = Date.now();

      return {
        newState: ConversationState.ERROR,
        replyText: `抱歉，行程规划过程中遇到了问题：${msg}`,
        error: msg,
      };
    }
  }

  private getKnownFields(ctx: ConversationContext): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    if (ctx.destination) result.destination = ctx.destination;
    if (ctx.departureCity) result.departureCity = ctx.departureCity;
    if (ctx.startDate) result.startDate = ctx.startDate;
    if (ctx.endDate) result.endDate = ctx.endDate;
    if (ctx.numTravelers) result.numTravelers = ctx.numTravelers;
    if (ctx.budget) result.budget = ctx.budget;
    if (ctx.accommodationStyle) result.accommodationStyle = ctx.accommodationStyle;
    if (ctx.travelInterests?.length) result.travelInterests = ctx.travelInterests;
    return result;
  }
}
