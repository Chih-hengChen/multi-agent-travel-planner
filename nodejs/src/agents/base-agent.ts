import type { Logger } from "pino";
import type { TravelPlanState } from "../types/index.js";
import type { TravelDataSource } from "../data-sources/types.js";
import { settings } from "../config/settings.js";
import { logWithSession } from "../logging/session-context.js";

const NOOP_SOURCE: TravelDataSource = {
  searchFlights: async () => [],
  searchHotels: async () => [],
  searchAttractions: async () => [],
  searchTrains: async () => [],
  searchRestaurants: async () => [],
};

export abstract class BaseAgent {
  abstract readonly name: string;
  protected readonly log: Logger;
  protected readonly dataSource: TravelDataSource;

  constructor(log: Logger, dataSource?: TravelDataSource) {
    this.log = log;
    this.dataSource = dataSource ?? NOOP_SOURCE;
  }

  async run(state: TravelPlanState): Promise<TravelPlanState> {
    this.log.info({ agent: this.name }, "开始执行...");
    logWithSession("agent_start", {
      agent: this.name,
      input: this.summarizeInput(state),
    });

    try {
      state = await this.execute(state);
      this.log.info({ agent: this.name }, "执行完成");
      logWithSession("agent_done", {
        agent: this.name,
        output: this.summarizeOutput(state),
      });
    } catch (exc) {
      const msg = exc instanceof Error ? exc.message : String(exc);
      this.log.error({ agent: this.name, err: msg }, "执行失败");
      state.errorMessages.push(`${this.name}: ${msg}`);
      logWithSession("agent_done", {
        agent: this.name,
        error: msg,
      });
    }
    return state;
  }

  private summarizeInput(state: TravelPlanState): Record<string, unknown> {
    const p = state.preferences;
    return {
      planningState: state.state,
      destination: state.selectedDestination?.city ?? p?.preferredDestination ?? "",
      departureCity: p?.departureCity ?? "",
      startDate: p?.startDate ?? "",
      endDate: p?.endDate ?? "",
      budget: p?.budget,
      numTravelers: p?.numTravelers,
    };
  }

  private summarizeOutput(state: TravelPlanState): Record<string, unknown> {
    return {
      planningState: state.state,
      transportMode: state.transportMode,
      trainOutbound: state.trainOutbound?.trainNo,
      trainReturn: state.trainReturn?.trainNo,
      flightCost: state.flightResult?.totalFlightCost,
      hotelName: state.hotelResult?.recommended?.name,
      hotelCost: state.hotelResult?.totalHotelCost,
      activityDays: state.activityResult?.dayPlans.length,
      activityCost: state.activityResult?.totalActivityCost,
      totalCost: state.budgetBreakdown?.totalCost,
      withinBudget: state.budgetBreakdown?.isWithinBudget,
      errors: state.errorMessages,
    };
  }

  protected abstract execute(state: TravelPlanState): Promise<TravelPlanState>;

  protected async callLlm(prompt: string, systemPrompt?: string, model?: string): Promise<string> {
    const usedModel = model ?? settings.LLM_MODEL;
    logWithSession("llm_request", {
      agent: this.name,
      model: usedModel,
      systemPrompt: systemPrompt?.slice(0, 200),
      messages: [{ role: "user", content: prompt.slice(0, 500) }],
    });
    const result = await this.realLlm(prompt, systemPrompt, model);
    logWithSession("llm_response", {
      agent: this.name,
      model: usedModel,
      response: result.slice(0, 500),
    });
    return result;
  }

  private async realLlm(prompt: string, systemPrompt?: string, model?: string): Promise<string> {
    const isAnthropic = settings.LLM_PROVIDER === "anthropic";
    const messages: Array<{ role: string; content: string }> = [];
    if (!isAnthropic && systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: prompt });

    if (isAnthropic) {
      return this.anthropicLlm(messages, systemPrompt, model);
    }
    return this.openaiLlm(messages, model);
  }

  private async anthropicLlm(
    messages: Array<{ role: string; content: string }>,
    systemPrompt?: string,
    model?: string,
  ): Promise<string> {
    const body: Record<string, unknown> = {
      model: model ?? settings.LLM_MODEL,
      messages,
      temperature: settings.LLM_TEMPERATURE,
      max_tokens: settings.LLM_MAX_TOKENS,
    };
    if (systemPrompt) body.system = systemPrompt;

    const resp = await fetch(`${settings.LLM_BASE_URL}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": settings.LLM_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const data = (await resp.json()) as { content: Array<{ type: string; text: string }>; error?: { message: string } };
    if (data.error) throw new Error(`Anthropic API error: ${data.error.message}`);
    return data.content[0].text;
  }

  private async openaiLlm(messages: Array<{ role: string; content: string }>, model?: string): Promise<string> {
    const resp = await fetch(`${settings.LLM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.LLM_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model ?? settings.LLM_MODEL,
        messages,
        temperature: settings.LLM_TEMPERATURE,
        max_tokens: settings.LLM_MAX_TOKENS,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices[0].message.content;
  }
}
