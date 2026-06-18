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
import type { PlanSummary, Flight, Train, Hotel, ProgressCallback } from "../types/index.js";
import type { Message } from "../api/llm-client.js";
import { withSessionId } from "../logging/session-context.js";
import { createInitialAgentState } from "../runtime/state.js";
import { runAgentLoop, type SSEEmitter, type LoopResult, type LLMCaller, type ToolExecutor, type LLMResponse, type LLMCallOptions } from "../runtime/agent-loop.js";
import { createSSEBridge } from "../runtime/sse.js";

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
    onProgress?: ProgressCallback,
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

    // ReAct recovery: use LLM to interpret user intent in selection state
    if (
      ctx.state === ConversationState.SELECTING_TRANSPORT ||
      ctx.state === ConversationState.SELECTING_HOTEL
    ) {
      return this.handleSelectingState(ctx, userMessage, onProgress);
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

    if (settings.USE_AGENT_LOOP && (newState === ConversationState.SEARCHING || newState === ConversationState.SEARCHING_TRANSPORT)) {
      return this.handleViaAgentLoop(ctx, userMessage, onProgress);
    }

    if (newState === ConversationState.SEARCHING_TRANSPORT) {
      return this.searchTransport(ctx);
    }

    if (newState === ConversationState.SEARCHING) {
      return this.runPipeline(ctx, onProgress);
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
    onProgress?: ProgressCallback,
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
        return this.runPipeline(ctx, onProgress);
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

  private async handleSelectingState(ctx: ConversationContext, userMessage: string, onProgress?: ProgressCallback): Promise<TurnResult> {
    const isHotel = ctx.state === ConversationState.SELECTING_HOTEL;
    let optionsStr: string;
    let optionCount = 0;
    if (isHotel) {
      const hotels = ctx.hotelOptions || [];
      optionCount = hotels.length;
      optionsStr = optionCount > 0
        ? hotels.map((h, i) => `${i + 1}. ${h.name} - ¥${h.pricePerNight}/晚 - 评分${h.userRating}${h.distanceToCenterKm ? ` - 距市中心${h.distanceToCenterKm}km` : ""}`).join("\n")
        : "(当前没有可用酒店)";
    } else {
      const transport = ctx.transportSearchResult;
      const allOpts = [...(transport?.outbound || []), ...(transport?.return || [])];
      optionCount = allOpts.length;
      optionsStr = optionCount > 0
        ? allOpts.map((t, i) => `${i + 1}. ${t.mode === "train" ? t.trainNo : t.flightNo} ${t.departStation}→${t.arriveStation} ${t.departTime}-${t.arriveTime} ¥${t.price}`).join("\n")
        : "(当前没有可用交通选项)";
    }

    try {
      const response = await this.callSelectionLlm(userMessage, isHotel, optionsStr, optionCount);

      // Try to extract tool call (function_call format)
      const choice = (response as any)?.choices?.[0]?.message;
      if (choice?.tool_calls?.length > 0) {
        const tc = choice.tool_calls[0];
        const fnName = tc.function?.name;
        const fnArgs = JSON.parse(tc.function?.arguments || "{}");

        if (fnName === "select_option" && typeof fnArgs.index === "number") {
          return this.executeOptionSelect(ctx, fnArgs.index, isHotel, onProgress);
        }
        if (fnName === "rescan") {
          if (isHotel) return this.searchHotels(ctx);
          return this.searchTransport(ctx);
        }
        if (fnName === "skip_selection") {
          if (isHotel) return this.runPipeline(ctx, onProgress);
          ctx.state = ConversationState.SELECTING_TRANSPORT;
          return { newState: ctx.state, replyText: "已跳过交通选择，是否继续规划？请选择出发城市和目的地。" };
        }
      }

      // LLM chose text response — return it as assistant reply
      const text = choice?.content || (response as any)?.content?.[0]?.text || "";
      if (text.trim()) {
        return { newState: ctx.state, replyText: text.trim() };
      }
    } catch (err) {
      this.log.warn({ err, state: ctx.state }, "ReAct recovery LLM call failed, using fallback");
    }

    // Fallback: if LLM call fails, return guidance
    const fallback = isHotel
      ? "请从上方酒店选项中选择一个。如果列表为空，我可以跳过酒店选择直接规划行程，或者您也可以修改条件重新搜索。"
      : "请从上方交通选项中选择一个。如果没有合适的选项，我可以重新搜索。";
    return { newState: ctx.state, replyText: fallback };
  }

  private async callSelectionLlm(userMessage: string, isHotel: boolean, optionsStr: string, optionCount: number): Promise<unknown> {
    const stateLabel = isHotel ? "SELECTING_HOTEL" : "SELECTING_TRANSPORT";
    const itemLabel = isHotel ? "酒店" : "交通";
    const systemPrompt = `你是一个旅行规划助手的对话恢复模块。用户当前处于 ${stateLabel} 状态，需要选择一个${itemLabel}。

当前可选${itemLabel}：
${optionsStr}

你可以调用以下函数来帮助用户：
1. select_option(index, type) — 当用户明确选择了某个选项时调用，index从1开始
2. rescan() — 当用户想重新搜索或更换条件时调用
3. skip_selection() — 当用户想跳过选择时调用（仅${isHotel ? "酒店" : "交通"}选择）

如果不确定用户意图，请直接回复用户解释当前状态并引导操作。回复要简洁自然。`;

    const tools = [{
      type: "function",
      function: {
        name: "select_option",
        description: `用户选择了某个${itemLabel}选项`,
        parameters: {
          type: "object",
          properties: {
            index: { type: "number", description: "选项序号，从1开始" },
            type: { type: "string", enum: ["transport", "hotel"] },
          },
          required: ["index", "type"],
        },
      },
    }, {
      type: "function",
      function: {
        name: "rescan",
        description: "用户想重新搜索或更换搜索条件",
        parameters: { type: "object", properties: { reason: { type: "string" } } },
      },
    }, {
      type: "function",
      function: {
        name: "skip_selection",
        description: `用户想跳过${itemLabel}选择`,
        parameters: { type: "object", properties: {} },
      },
    }];

    if (settings.LLM_PROVIDER === "anthropic") {
      const resp = await fetch(`${settings.LLM_BASE_URL}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": settings.LLM_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
        body: JSON.stringify({
          model: settings.LLM_LIGHT_MODEL,
          system: systemPrompt,
          messages: [{ role: "user", content: userMessage }],
          tools: tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })),
          temperature: settings.LLM_TEMPERATURE_STRUCTURED,
          max_tokens: 1024,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      return resp.json();
    }

    const resp = await fetch(`${settings.LLM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${settings.LLM_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: settings.LLM_LIGHT_MODEL,
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }],
        tools,
        temperature: settings.LLM_TEMPERATURE_STRUCTURED,
        max_tokens: 1024,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    return resp.json();
  }

  async handleViaAgentLoop(
    ctx: ConversationContext,
    userMessage: string,
    onProgress?: ProgressCallback,
  ): Promise<TurnResult> {
    const agentState: import("../runtime/state.js").AgentState = ctx.agentState ?? createInitialAgentState();
    const messages: Message[] = ctx.messageHistory.map(m => ({
      role: m.role === "user" ? "user" : "assistant",
      content: [{ type: "text" as const, text: m.content }],
    }));

    const llmCaller: LLMCaller = {
      async call(opts: LLMCallOptions): Promise<LLMResponse> {
        const body: Record<string, unknown> = {
          model: opts.model,
          messages: opts.messages,
          system: opts.systemPrompt,
          max_tokens: opts.maxTokens,
          temperature: opts.temperature,
        };
        if (opts.tools.length > 0) { body.tools = opts.tools; }

        const resp = await fetch(`${settings.LLM_BASE_URL}/v1/messages`, {
          method: "POST",
          headers: { "x-api-key": settings.LLM_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120_000),
        });
        if (!resp.ok) throw new Error(`LLM API ${resp.status}: ${await resp.text()}`);
        const data = await resp.json() as { content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>; stop_reason?: string };

        const textBlocks = data.content.filter(c => c.type === "text").map(c => c.text ?? "").join("");
        const toolCalls = data.content.filter(c => c.type === "tool_use").map(c => ({
          id: c.id, name: c.name!, input: c.input!,
        }));

        return { stopReason: data.stop_reason ?? "", text: textBlocks, toolCalls };
      },
    };

    const toolExecutor: ToolExecutor = {
      async execute(call, state) {
        return { success: true, data: { toolName: call.name, input: call.input } };
      },
    };

    const schemaLookup: import("../runtime/validate-tool-calls.js").SchemaLookup = {
      getSchema(_name) { return { safeParse: (v: unknown) => ({ success: true, data: v }) }; },
      getPrecondition(_name) { return undefined; },
    };

    const emit = onProgress ? createSSEBridge((event, data) => onProgress({ phase: "", progress: 0, message: `${event}: ${JSON.stringify(data)}`, eta: 0 })) : undefined;

    try {
      const result = await runAgentLoop(ctx.sessionId, agentState, messages, userMessage, {
        llmCaller,
        schemaLookup,
        toolExecutor,
        emit,
      });

      ctx.agentState = result.state;
      ctx.updatedAt = Date.now();

      const lastMsg = result.messages[result.messages.length - 1];
      const replyText = lastMsg && typeof lastMsg.content === "string"
        ? lastMsg.content
        : (Array.isArray(lastMsg?.content)
          ? (lastMsg.content as Array<{ type: string; text?: string }>).find(c => c.type === "text")?.text ?? "行程已生成"
          : "行程已生成");

      return { newState: ConversationState.COMPLETED, replyText };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { newState: ConversationState.ERROR_RECOVERABLE, replyText: `行程生成失败:${msg}`, error: msg };
    }
  }

  private async executeOptionSelect(ctx: ConversationContext, index: number, isHotel: boolean, onProgress?: ProgressCallback): Promise<TurnResult> {
    if (isHotel) {
      const options = ctx.hotelOptions || [];
      const hotel = options[index];
      if (!hotel) return { newState: ctx.state, replyText: `没有找到序号 ${index} 对应的选项，请重新选择。` };
      ctx.selectedHotel = hotel;
      if (canTransition(ctx.state, ConversationState.SEARCHING)) {
        return this.runPipeline(ctx, onProgress);
      }
      return { newState: ctx.state, replyText: `已选择 ${hotel.name}，正在为您规划行程...` };
    }

    // Transport selection via ReAct — reuse handleSelect's logic
    const result = await this.handleSelect(ctx, {
      type: "transport",
      outboundId: String(index),
      returnId: String(index),
    });
    return result;
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

  private async runPipeline(ctx: ConversationContext, onProgress?: ProgressCallback): Promise<TurnResult> {
    ctx.state = ConversationState.SEARCHING;
    ctx.updatedAt = Date.now();

    const introText = `好的，正在为您规划${ctx.destination ?? ""}的完整行程，请稍候...`;

    return withSessionId(ctx.sessionId, async () => {
    try {
      const prefs = toUserPreferences(ctx);
      const state = await this.pipeline.run(prefs, onProgress);
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
