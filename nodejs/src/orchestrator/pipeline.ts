import pino, { type Logger } from "pino";
import { TravelStyle, TravelPlanState, PlanningState, type UserPreferences, type Destination, type ProgressCallback } from "../types/index.js";
import { PreferenceAgent, FlightAgent, HotelAgent, ActivityAgent, LLMPlanAgent, BudgetAgent } from "../agents/index.js";
import { AmadeusSource } from "../data-sources/amadeus-source.js";
import { BookingSource } from "../data-sources/booking-source.js";
import { AmapSource } from "../data-sources/amap-source.js";
import { WebSearchSource } from "../data-sources/web-search-source.js";
import { Train12306Source } from "../data-sources/train12306-source.js";
import { FallbackDataSource } from "../data-sources/fallback-data-source.js";
import type { TravelDataSource } from "../data-sources/types.js";
import { PipelineExecutor } from "./parallel.js";
import { BudgetLoopController } from "./budget-loop.js";
import { sessionLogger } from "../logging/session-logger.js";
import * as destinationPrompt from "../prompts/destination-detail.js";
import { settings } from "../config/settings.js";

class CompositeDataSource implements TravelDataSource {
  constructor(
    private readonly flights: TravelDataSource,
    private readonly hotels: TravelDataSource,
    private readonly attractions: TravelDataSource,
    private readonly trains: TravelDataSource,
  ) {}

  searchFlights(params: Parameters<TravelDataSource["searchFlights"]>[0]) {
    return this.flights.searchFlights(params);
  }
  searchHotels(params: Parameters<TravelDataSource["searchHotels"]>[0]) {
    return this.hotels.searchHotels(params);
  }
  searchAttractions(params: Parameters<TravelDataSource["searchAttractions"]>[0]) {
    return this.attractions.searchAttractions(params);
  }
  searchTrains(params: Parameters<TravelDataSource["searchTrains"]>[0]) {
    return this.trains.searchTrains(params);
  }
  searchRestaurants(params: Parameters<TravelDataSource["searchRestaurants"]>[0]) {
    return this.attractions.searchRestaurants(params);
  }
  planTransitRoute(origin: import("../types/index.js").GeoLocation, destination: import("../types/index.js").GeoLocation, city: string) {
    return this.attractions.planTransitRoute?.(origin, destination, city) ?? Promise.resolve(null);
  }
}

async function callLlmEnrich(city: string, budget: number): Promise<string> {
  const isAnthropic = settings.LLM_PROVIDER === "anthropic";
  const messages: Array<{ role: string; content: string }> = [{ role: "user", content: destinationPrompt.build({ city, budget }) }];

  if (isAnthropic) {
    const resp = await fetch(`${settings.LLM_BASE_URL}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": settings.LLM_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: settings.LLM_LIGHT_MODEL,
        messages,
        temperature: settings.LLM_TEMPERATURE_STRUCTURED,
        max_tokens: settings.LLM_MAX_TOKENS,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = (await resp.json()) as { content: Array<{ type: string; text: string }>; error?: { message: string } };
    if (data.error) throw new Error(`Anthropic API error: ${data.error.message}`);
    return data.content[0].text;
  }

  const resp = await fetch(`${settings.LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.LLM_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: settings.LLM_LIGHT_MODEL,
      messages,
      temperature: settings.LLM_TEMPERATURE_STRUCTURED,
      max_tokens: settings.LLM_MAX_TOKENS,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
  return data.choices[0].message.content;
}

async function enrichDestination(city: string, budget: number): Promise<Destination> {
  try {
    const raw = await callLlmEnrich(city, budget);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("no JSON in LLM response");
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    return {
      city,
      country: String(parsed.country ?? ""),
      description: String(parsed.description ?? ""),
      bestSeason: String(parsed.bestSeason ?? "spring,autumn"),
      visaRequired: Boolean(parsed.visaRequired),
      safetyScore: Number(parsed.safetyScore) || 8.0,
      costLevel: String(parsed.costLevel ?? "medium"),
      highlights: Array.isArray(parsed.highlights) ? parsed.highlights.map(String) : [],
    };
  } catch (err) {
    return {
      city,
      country: "",
      description: `${city}旅行`,
      bestSeason: "spring,autumn",
      visaRequired: false,
      safetyScore: 8.0,
      costLevel: "medium",
      highlights: [],
    };
  }
}

const AGENT_WEIGHTS: Record<string, number> = {
  PreferenceAgent: 2,
  enrichDestination: 3,
  FlightAgent: 20,
  HotelAgent: 20,
  LLMPlanAgent: 40,
  BudgetAgent: 5,
};

const ROUND_WEIGHT = 85; // Flight(20) + Hotel(20) + LLMPlan(40) + Budget(5)

class ProgressTracker {
  private completedWeight = 0;
  private totalWeight: number;
  private startTime: number;

  constructor(maxRounds: number) {
    this.totalWeight = 5 + ROUND_WEIGHT * maxRounds;
    this.startTime = Date.now();
  }

  add(agentName: string): void {
    this.completedWeight += AGENT_WEIGHTS[agentName] ?? 0;
  }

  adjustTotal(maxRounds: number): void {
    this.totalWeight = 5 + ROUND_WEIGHT * maxRounds;
  }

  getPercent(): number {
    return Math.min(100, Math.round((this.completedWeight / Math.max(this.totalWeight, 1)) * 100));
  }

  getEta(): number {
    const elapsed = (Date.now() - this.startTime) / 1000;
    const done = this.completedWeight;
    const remaining = Math.max(0, this.totalWeight - done);
    const speed = done / Math.max(elapsed, 1);
    return Math.round(remaining / Math.max(speed, 0.1));
  }
}

export class TravelPlanningPipeline {
  private readonly prefAgent: PreferenceAgent;
  private readonly flightHotelExecutor: PipelineExecutor;
  private readonly planExecutor: PipelineExecutor;
  private readonly budgetLoop: BudgetLoopController;
  private readonly activityAgent: ActivityAgent;
  private readonly log: Logger;

  constructor(log?: Logger, public ragEnabled = true) {
    this.log = log ?? pino({ level: "info" });
    const webSearch = new WebSearchSource(this.log);
    const dataSource = new CompositeDataSource(
      new FallbackDataSource(new AmadeusSource(), webSearch, this.log),
      new FallbackDataSource(new BookingSource(), webSearch, this.log),
      new FallbackDataSource(new AmapSource(), webSearch, this.log),
      new FallbackDataSource(new Train12306Source(this.log), webSearch, this.log),
    );

    const flightAgent = new FlightAgent(this.log, dataSource);
    const hotelAgent = new HotelAgent(this.log, dataSource);
    const llmPlanAgent = new LLMPlanAgent(this.log, dataSource);
    this.activityAgent = new ActivityAgent(this.log, dataSource);
    const budgetAgent = new BudgetAgent(this.log, dataSource);

    this.prefAgent = new PreferenceAgent(this.log);

    this.flightHotelExecutor = new PipelineExecutor([flightAgent, hotelAgent], this.log);
    this.planExecutor = new PipelineExecutor([llmPlanAgent], this.log, 240_000);
    this.budgetLoop = new BudgetLoopController(this.flightHotelExecutor, this.planExecutor, budgetAgent, this.log);
  }

  async run(preferences: UserPreferences, onProgress?: ProgressCallback): Promise<TravelPlanState> {
    const state = new TravelPlanState();
    state.preferences = preferences;
    const tracker = new ProgressTracker(settings.BUDGET_MAX_RETRIES + 1);

    state.state = PlanningState.COLLECTING_PREFERENCES;
    let result = await this.prefAgent.run(state);
    tracker.add("PreferenceAgent");
    if (onProgress) {
      onProgress({ phase: "准备规划", status: "completed", progressPercent: tracker.getPercent(), estimatedSecondsLeft: tracker.getEta() });
    }
    if (result.state === PlanningState.FAILED) return result;

    result = await this.runDestinationEnrichment(result);
    tracker.add("enrichDestination");
    if (onProgress) {
      onProgress({ phase: "目的地分析完成", status: "completed", progressPercent: tracker.getPercent(), estimatedSecondsLeft: tracker.getEta() });
    }
    if (result.state === PlanningState.FAILED) return result;

    await this.refreshSelectedPrices(result);

    const wrappedProgress: ProgressCallback = (update) => {
      if (update.status === "completed" || update.status === "degraded" || update.status === "failed") {
        tracker.add(update.agentName ?? update.phase);
      }
      if (onProgress) {
        onProgress({ ...update, progressPercent: tracker.getPercent(), estimatedSecondsLeft: tracker.getEta() });
      }
    };
    result = await this.budgetLoop.run(result, wrappedProgress);

    if (this.isActivityMissing(result) && result.state !== PlanningState.FAILED) {
      this.log.warn("活动规划缺失，降级到 ActivityAgent (mock)。");
      sessionLogger.append("pipeline", "pipeline_fallback", {
        reason: "LLMPlanAgent 失败或超时",
        fallback: "ActivityAgent",
      });
      try {
        result = await this.activityAgent.run(result);
      } catch (fallbackErr) {
        const msg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        this.log.error({ error: msg }, "ActivityAgent fallback 也失败");
        result.errorMessages.push(`活动规划失败: ${msg}`);
      }
    }

    return result;
  }

  private async runDestinationEnrichment(state: TravelPlanState): Promise<TravelPlanState> {
    const pref = state.preferences;
    if (!pref) { state.state = PlanningState.FAILED; return state; }

    const target = pref.preferredDestination || "";
    if (!target) { state.state = PlanningState.FAILED; return state; }

    const selected = await enrichDestination(target, pref.budget);
    state.destinationRec = {
      destinations: [selected],
      selected,
      reasoning: `根据您的偏好，推荐 ${selected.city}`,
    };
    state.state = PlanningState.SEARCHING_PARALLEL;
    this.log.info({ agent: "DestinationAgent(inline)", city: selected.city, country: selected.country }, "推荐目的地");
    return state;
  }

  private isActivityMissing(state: TravelPlanState): boolean {
    return (
      !state.activityResult ||
      !state.activityResult.dayPlans ||
      state.activityResult.dayPlans.length === 0
    );
  }

  private async refreshSelectedPrices(state: TravelPlanState): Promise<void> {
    const pref = state.preferences;
    if (!pref) return;
    const THRESHOLD = 0.10;

    const checks: Array<{ label: string; selected: { price: number }; key: string }> = [];
    if (pref.selectedOutbound && "price" in pref.selectedOutbound) {
      checks.push({ label: `去程 ${("flightNo" in pref.selectedOutbound ? pref.selectedOutbound.flightNo : "")}`, selected: pref.selectedOutbound as { price: number }, key: "selectedOutbound" });
    }
    if (pref.selectedReturn && "price" in pref.selectedReturn) {
      checks.push({ label: `返程 ${("flightNo" in pref.selectedReturn ? pref.selectedReturn.flightNo : "")}`, selected: pref.selectedReturn as { price: number }, key: "selectedReturn" });
    }

    for (const { label, selected, key } of checks) {
      try {
        const fresh = await this.dataSource.searchFlights({
          origin: (selected as Record<string, unknown>).departureCity as string,
          destination: (selected as Record<string, unknown>).arrivalCity as string,
          departureDate: ((selected as Record<string, unknown>).departureTime as string).slice(0, 10),
          adults: pref.numTravelers,
        });
        const flightNo = (selected as Record<string, unknown>).flightNo;
        const match = fresh.find(f => f.flightNo === flightNo);
        if (match && Math.abs(match.price - selected.price) / selected.price > THRESHOLD) {
          const dir = match.price > selected.price ? "+" : "";
          state.priceWarnings.push(
            `${label} 价格已从 ¥${selected.price} 变为 ¥${match.price} (${dir}${((match.price - selected.price) / selected.price * 100).toFixed(0)}%)`
          );
          (pref as Record<string, unknown>)[key] = match;
        }
      } catch { /* 校验失败不阻塞 pipeline */ }
    }

    if (pref.selectedHotel) {
      try {
        const fresh = await this.dataSource.searchHotels({
          city: pref.destination,
          checkIn: pref.startDate,
          checkOut: pref.endDate,
          adults: pref.numTravelers,
        });
        const hotelName = pref.selectedHotel.name;
        const match = fresh.find(h => h.name === hotelName);
        if (match && Math.abs(match.pricePerNight - pref.selectedHotel.pricePerNight) / pref.selectedHotel.pricePerNight > THRESHOLD) {
          const dir = match.pricePerNight > pref.selectedHotel.pricePerNight ? "+" : "";
          state.priceWarnings.push(
            `酒店 ${hotelName} 价格已从 ¥${pref.selectedHotel.pricePerNight}/晚 变为 ¥${match.pricePerNight}/晚 (${dir}${((match.pricePerNight - pref.selectedHotel.pricePerNight) / pref.selectedHotel.pricePerNight * 100).toFixed(0)}%)`
          );
          pref.selectedHotel = match;
        }
      } catch { /* 校验失败不阻塞 pipeline */ }
    }
  }
}

export async function quickPlan(opts: {
  budget?: number;
  departure?: string;
  start?: string;
  end?: string;
  style?: string;
  travelers?: number;
} = {}): Promise<TravelPlanState> {
  const prefs: UserPreferences = {
    budget: opts.budget ?? 10000,
    travelStyle: (opts.style as TravelStyle) ?? TravelStyle.COMFORT,
    departureCity: opts.departure ?? "北京",
    startDate: opts.start ?? "2026-05-01",
    endDate: opts.end ?? "2026-05-05",
    numTravelers: opts.travelers ?? 1,
    interests: [],
    dietaryRestrictions: [],
    accessibilityNeeds: [],
    notes: "",
    outboundTransportPreference: "no_preference",
    returnTransportPreference: "no_preference",
    mustVisitAttractions: [],
    departureTime: "flexible",
    budgetStrictness: "strict",
    accommodationType: "any",
    preferredHotelBrands: [],
    localTransitMode: "mixed",
    diningPreference: "mixed",
  };
  const pipeline = new TravelPlanningPipeline();
  return pipeline.run(prefs);
}
