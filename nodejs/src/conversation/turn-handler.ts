import pino, { type Logger } from "pino";
import { ConversationState, advanceState, canTransition } from "./state-machine.js";
import {
  type ConversationContext,
  type ExtractedFields,
  type TransportOption,
  type TransportSearchResult,
  mergeExtracted,
  toUserPreferences,
  buildPlanSummary,
} from "./context.js";
import { InfoExtractor } from "./info-extractor.js";
import { GatheringAgent } from "../agents/gathering-agent.js";
import { IntentRouter } from "../intent-router/index.js";
import type { RouteDecision } from "../intent-router/types.js";
import { sessionLogger } from "../logging/session-logger.js";
import { TravelPlanningPipeline } from "../orchestrator/pipeline.js";
import { SourceResolver } from "../data-sources/source-resolver.js";
import { AmadeusSource } from "../data-sources/amadeus-source.js";
import { BookingSource } from "../data-sources/booking-source.js";
import { AmapSource } from "../data-sources/amap-source.js";
import { WebSearchSource } from "../data-sources/web-search-source.js";
import { Train12306Source } from "../data-sources/train12306-source.js";
import { settings } from "../config/settings.js";
import type { PlanSummary, Flight, Train, Hotel } from "../types/index.js";
import { withSessionId } from "../logging/session-context.js";

export interface TurnResult {
  newState: ConversationState;
  replyText: string;
  questionFields?: string[];
  planResult?: PlanSummary;
  transportOptions?: TransportSearchResult;
  hotelOptions?: Hotel[];
  error?: string;
}

export interface SelectRequest {
  type: "transport" | "hotel";
  action?: "confirm" | "rescan";
  outboundId?: string;
  returnId?: string;
  hotelId?: string;
}

export class TurnHandler {
  private readonly infoExtractor: InfoExtractor;
  private readonly gatheringAgent: GatheringAgent;
  private readonly pipeline: TravelPlanningPipeline;
  private readonly intentRouter: IntentRouter;
  private readonly log: Logger;

  constructor(
    infoExtractor: InfoExtractor,
    gatheringAgent: GatheringAgent,
    pipeline: TravelPlanningPipeline,
    intentRouter?: IntentRouter,
    log?: Logger,
  ) {
    this.infoExtractor = infoExtractor;
    this.gatheringAgent = gatheringAgent;
    this.pipeline = pipeline;
    this.intentRouter = intentRouter ?? new IntentRouter();
    this.log = log ?? pino({ level: settings.LOG_LEVEL });
  }

  async handleTurn(
    ctx: ConversationContext,
    userMessage: string,
  ): Promise<TurnResult> {
    ctx.messageHistory.push({ role: "user", content: userMessage });
    ctx.turnCount++;

    const routeDecision = this.intentRouter.route(userMessage, {
      state: ctx.state,
      destination: ctx.destination,
      departureCity: ctx.departureCity,
      startDate: ctx.startDate,
      endDate: ctx.endDate,
      numTravelers: ctx.numTravelers,
      budget: ctx.budget,
    });
    sessionLogger.append(ctx.sessionId, "route_decision", routeDecision);

    if (routeDecision.intent === "simple_answer" && ctx.state === ConversationState.INIT && !ctx.destination) {
      ctx.state = ConversationState.INIT;
      ctx.updatedAt = Date.now();
      return {
        newState: ConversationState.INIT,
        replyText: "您好！我是旅行规划助手，可以帮您规划旅行行程。请告诉我您想去哪里？",
      };
    }

    if (ctx.state === ConversationState.ERROR_RECOVERABLE && ctx.lastError) {
      if (ctx.lastError.retryCount < 2) {
        this.log.info({ sessionId: ctx.sessionId }, "Retrying from ERROR state");
        ctx.lastError.retryCount++;
      } else {
        return {
          newState: ConversationState.ERROR_RECOVERABLE,
          replyText: "抱歉，系统暂时无法处理您的请求，请稍后再试。",
          error: "Max retries exceeded",
        };
      }
    }

    // If user is in a selection state, treat message as natural language selection guidance
    if (
      ctx.state === ConversationState.SELECTING_TRANSPORT ||
      ctx.state === ConversationState.SELECTING_HOTEL
    ) {
      const reply =
        ctx.state === ConversationState.SELECTING_TRANSPORT
          ? "请从上方交通选项中选择一个，或点击「重新搜索」。"
          : "请从上方酒店选项中选择一个，或点击「更换交通」重新选择。";
      return { newState: ctx.state, replyText: reply };
    }

    const knownFields = this.getKnownFields(ctx);
    let extracted: ExtractedFields;
    try {
      extracted = await this.infoExtractor.extract(
        userMessage,
        ctx.messageHistory.slice(0, -1),
        knownFields,
        ctx.sessionId,
      );
    } catch (err) {
      this.log.warn({ err }, "InfoExtractor failed, continuing with empty extraction");
      extracted = {};
    }

    if (Object.keys(extracted).length > 0) {
      Object.assign(ctx, mergeExtracted(ctx, extracted));
    }

    const newState = advanceState(ctx, settings.MAX_GATHERING_TURNS);

    if (newState === ConversationState.SEARCHING_TRANSPORT) {
      return this.searchTransport(ctx);
    }

    if (newState === ConversationState.SEARCHING) {
      return this.runPipeline(ctx);
    }

    ctx.state = newState;

    if (
      newState === ConversationState.GATHERING_BASICS ||
      newState === ConversationState.GATHERING_PREFERENCES ||
      newState === ConversationState.INIT
    ) {
      const question = await this.gatheringAgent.generateQuestion(ctx, ctx.sessionId);
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

  async handleSelect(
    ctx: ConversationContext,
    request: SelectRequest,
  ): Promise<TurnResult> {
    if (request.action === "rescan") {
      if (ctx.state === ConversationState.SELECTING_TRANSPORT) {
        return this.searchTransport(ctx);
      }
      if (ctx.state === ConversationState.SELECTING_HOTEL) {
        return this.searchHotels(ctx);
      }
    }

    if (
      ctx.state === ConversationState.SELECTING_TRANSPORT &&
      request.type === "transport"
    ) {
      if (!request.outboundId || !request.returnId) {
        return {
          newState: ctx.state,
          replyText: "请同时选择去程和返程交通。",
        };
      }

      ctx.selectedOutboundId = request.outboundId;
      ctx.selectedReturnId = request.returnId;

      if (canTransition(ctx.state, ConversationState.SEARCHING_HOTELS)) {
        return this.searchHotels(ctx);
      }

      return {
        newState: ctx.state,
        replyText: "交通选择已记录，正在为您搜索酒店...",
      };
    }

    if (
      ctx.state === ConversationState.SELECTING_HOTEL &&
      request.type === "hotel"
    ) {
      if (!request.hotelId) {
        return {
          newState: ctx.state,
          replyText: "请选择一个酒店。",
        };
      }

      ctx.selectedHotel = ctx.hotelOptions?.find((h) => h.name === request.hotelId);

      if (canTransition(ctx.state, ConversationState.SEARCHING)) {
        return this.runPipeline(ctx);
      }

      return {
        newState: ctx.state,
        replyText: "酒店选择已记录，正在为您规划行程...",
      };
    }

    return {
      newState: ctx.state,
      replyText: "当前状态无法处理该选择操作。",
    };
  }

  private async searchTransport(ctx: ConversationContext): Promise<TurnResult> {
    ctx.state = ConversationState.SEARCHING_TRANSPORT;
    ctx.updatedAt = Date.now();

    const introText = `正在为您搜索${ctx.departureCity ?? ""}到${ctx.destination ?? ""}的交通方式...`;

    return withSessionId(ctx.sessionId, async () => {
    try {
      const resolver = this.createSourceResolver();
      const prefs = toUserPreferences(ctx);
      const isOutboundTrain =
        prefs.outboundTransportPreference === "high_speed_rail" ||
        prefs.outboundTransportPreference === "train";
      const isReturnTrain =
        prefs.returnTransportPreference === "high_speed_rail" ||
        prefs.returnTransportPreference === "train";

      const outbound: TransportOption[] = [];
      const returnOpts: TransportOption[] = [];

      if (isOutboundTrain || prefs.outboundTransportPreference === "no_preference") {
        const trains = await resolver.resolveTrains({
          from: ctx.departureCity ?? "",
          to: ctx.destination ?? "",
          date: ctx.startDate ?? "",
        });
        outbound.push(...trains.slice(0, settings.MAX_TRANSPORT_OPTIONS).map(trainToOption));
      }

      if (isReturnTrain || prefs.returnTransportPreference === "no_preference") {
        const trains = await resolver.resolveTrains({
          from: ctx.destination ?? "",
          to: ctx.departureCity ?? "",
          date: ctx.endDate ?? "",
        });
        returnOpts.push(...trains.slice(0, settings.MAX_TRANSPORT_OPTIONS).map(trainToOption));
      }

      if (!isOutboundTrain || outbound.length === 0) {
        const flights = await resolver.resolveFlights({
          origin: ctx.departureCity ?? "",
          destination: ctx.destination ?? "",
          departureDate: ctx.startDate ?? "",
          adults: ctx.numTravelers ?? 1,
        });
        if (outbound.length === 0) {
          outbound.push(...flights.slice(0, settings.MAX_TRANSPORT_OPTIONS).map(flightToOption));
        }
      }

      if (!isReturnTrain || returnOpts.length === 0) {
        const flights = await resolver.resolveFlights({
          origin: ctx.destination ?? "",
          destination: ctx.departureCity ?? "",
          departureDate: ctx.endDate ?? "",
          adults: ctx.numTravelers ?? 1,
        });
        if (returnOpts.length === 0) {
          returnOpts.push(...flights.slice(0, settings.MAX_TRANSPORT_OPTIONS).map(flightToOption));
        }
      }

      if (outbound.length > 0) outbound[0].isRecommended = true;
      if (returnOpts.length > 0) returnOpts[0].isRecommended = true;

      const result: TransportSearchResult = { outbound, return: returnOpts };
      ctx.transportSearchResult = result;

      if (canTransition(ctx.state, ConversationState.SELECTING_TRANSPORT)) {
        ctx.state = ConversationState.SELECTING_TRANSPORT;
        ctx.updatedAt = Date.now();
      }

      return {
        newState: ctx.state,
        replyText: introText,
        transportOptions: result,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error({ err: msg, sessionId: ctx.sessionId }, "Transport search failed");

      ctx.state = ConversationState.ERROR_RECOVERABLE;
      ctx.lastError = {
        state: ConversationState.SEARCHING_TRANSPORT,
        message: msg,
        retryCount: 0,
        timestamp: Date.now(),
      };
      ctx.updatedAt = Date.now();

      return {
        newState: ConversationState.ERROR_RECOVERABLE,
        replyText: `交通搜索失败：${msg}`,
        error: msg,
      };
    }
    });
  }

  private async searchHotels(ctx: ConversationContext): Promise<TurnResult> {
    ctx.state = ConversationState.SEARCHING_HOTELS;
    ctx.updatedAt = Date.now();

    const introText = `正在为您搜索${ctx.destination ?? ""}的酒店...`;

    return withSessionId(ctx.sessionId, async () => {
    try {
      const resolver = this.createSourceResolver();
      const numDays = ctx.numDays ?? 4;
      const travelers = ctx.numTravelers ?? 1;
      const maxPerNight = ctx.budget
        ? Math.floor((ctx.budget * 0.4) / numDays)
        : undefined;

      const hotels = await resolver.resolveHotels({
        city: ctx.destination ?? "",
        checkIn: ctx.startDate ?? "",
        checkOut: ctx.endDate ?? "",
        adults: travelers,
        maxPricePerNight: maxPerNight,
      });

      const trimmed = hotels.slice(0, settings.MAX_HOTEL_OPTIONS);
      ctx.hotelOptions = trimmed;

      if (canTransition(ctx.state, ConversationState.SELECTING_HOTEL)) {
        ctx.state = ConversationState.SELECTING_HOTEL;
        ctx.updatedAt = Date.now();
      }

      return {
        newState: ctx.state,
        replyText: introText,
        hotelOptions: trimmed,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error({ err: msg, sessionId: ctx.sessionId }, "Hotel search failed");

      ctx.state = ConversationState.ERROR_RECOVERABLE;
      ctx.lastError = {
        state: ConversationState.SEARCHING_HOTELS,
        message: msg,
        retryCount: 0,
        timestamp: Date.now(),
      };
      ctx.updatedAt = Date.now();

      return {
        newState: ConversationState.ERROR_RECOVERABLE,
        replyText: `酒店搜索失败：${msg}`,
        error: msg,
      };
    }
    });
  }

  private async runPipeline(ctx: ConversationContext): Promise<TurnResult> {
    ctx.state = ConversationState.SEARCHING;
    ctx.updatedAt = Date.now();

    const introText = `好的，正在为您规划${ctx.destination ?? ""}的完整行程，请稍候...`;

    return withSessionId(ctx.sessionId, async () => {
    try {
      const prefs = toUserPreferences(ctx);
      const state = await this.pipeline.run(prefs);
      const planResult = buildPlanSummary(state);

      ctx.planSummary = planResult;
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

      ctx.state = ConversationState.ERROR_RECOVERABLE;
      ctx.lastError = {
        state: ConversationState.SEARCHING,
        message: msg,
        retryCount: 0,
        timestamp: Date.now(),
      };
      ctx.updatedAt = Date.now();

      return {
        newState: ConversationState.ERROR_RECOVERABLE,
        replyText: `行程规划失败：${msg}`,
        error: msg,
      };
    }
    });
  }

  private createSourceResolver(): SourceResolver {
    const log = this.log;
    const webSearch = new WebSearchSource(log);
    const sources = [
      new AmadeusSource(),
      new BookingSource(),
      new AmapSource(),
      new Train12306Source(log),
      webSearch,
    ];
    return new SourceResolver(sources, log);
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

function trainToOption(t: Train): TransportOption {
  return {
    id: t.trainNo,
    mode: "train",
    trainNo: t.trainNo,
    departStation: t.departureCity,
    arriveStation: t.arrivalCity,
    departTime: t.departureTime,
    arriveTime: t.arrivalTime,
    duration: `${t.durationHours}小时`,
    price: t.price,
    note: `${t.trainType} ${t.seatType}`,
    isRecommended: false,
  };
}

function flightToOption(f: Flight): TransportOption {
  return {
    id: f.flightNo,
    mode: "flight",
    flightNo: f.flightNo,
    airline: f.airline,
    departStation: f.departureCity,
    arriveStation: f.arrivalCity,
    departTime: f.departureTime,
    arriveTime: f.arrivalTime,
    duration: `${f.durationHours}小时`,
    price: f.price,
    note: `${f.airline} ${f.cabinClass}`,
    isRecommended: false,
  };
}
