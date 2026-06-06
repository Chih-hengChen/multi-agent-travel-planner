import type { Logger } from "pino";
import { ActivitySubType, type Activity, type DayPlan, type TravelPlanState, type UserPreferences, type Train, type Flight, type Hotel } from "../types/index.js";
import type { TravelDataSource } from "../data-sources/types.js";
import { settings } from "../config/settings.js";
import { BaseAgent } from "./base-agent.js";
import { sessionLogger } from "../logging/session-logger.js";
import { getSessionId } from "../logging/session-context.js";
import { AmapWeatherSource } from "../data-sources/amap-weather-source.js";
import { WebSearchSource } from "../data-sources/web-search-source.js";
import { buildSystemPrompt, PROMPT_VERSION } from "./llm-plan-prompt.js";

export class LLMPlanAgent extends BaseAgent {
  readonly name = "LLMPlanAgent";
  constructor(log: Logger, dataSource: TravelDataSource) { super(log, dataSource); }

  protected async execute(state: TravelPlanState): Promise<TravelPlanState> {
    const pref = state.preferences!;
    const dest = state.selectedDestination!;
    const days = this.getTravelDays(pref.startDate, pref.endDate);

    let cityKnowledge = "";
    try {
      const webSearch = new WebSearchSource(this.log);
      cityKnowledge = await webSearch.getCityKnowledge(dest.city);
      if (cityKnowledge) {
        this.log.info({ city: dest.city, len: cityKnowledge.length }, "city-knowledge: fetched for LLM plan");
      }
    } catch { /* city knowledge unavailable */ }

    let weatherSummary = "";
    try {
      const weatherSource = new AmapWeatherSource();
      const weather = await weatherSource.getFullWeather(dest.city);
      if (weather) {
        if (weather.live) {
          weatherSummary += "【当前天气】" + weather.live.city + " " + weather.live.weather
            + " " + weather.live.temperature + "℃ " + weather.live.winddirection + "风 " + weather.live.windpower + "级\n";
        }
        if (weather.forecast?.casts?.length) {
          weatherSummary += "【天气预报】\n";
          for (const c of weather.forecast.casts) {
            weatherSummary += c.date + " 白天:" + c.dayweather + " " + c.daytemp + "℃"
              + " 夜间:" + c.nightweather + " " + c.nighttemp + "℃"
              + " " + c.daywind + "风" + c.daypower + "级\n";
          }
        }
      }
    } catch { /* weather unavailable */ }

    const tools = this.buildToolDefs();
    const systemPrompt = buildSystemPrompt(pref, dest.city, days, weatherSummary, cityKnowledge);
    let messages: Array<{ role: "user" | "assistant"; content: string | unknown[] }> = [
      { role: "user", content: systemPrompt },
    ];

    let hasSearchedWeather = false;
    let hasSearchedAttractions = false;
    let hasSearchedDining = false;
    const toolCallHistory: string[] = [];
    const MAX_CONTEXT_CHARS = 100_000;

    const maxRounds = 10;
    for (let round = 0; round < maxRounds; round++) {
      let currentState = "COMPILE";
      if (!hasSearchedWeather) currentState = "FETCH_WEATHER";
      else if (!hasSearchedAttractions) currentState = "SEARCH_ATTRACTIONS";
      else if (!hasSearchedDining) currentState = "SEARCH_DINING";

      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.role === "user" && Array.isArray(lastMsg.content) && lastMsg.content.length > 0) {
        const stateHint = "\n[state: " + currentState + "] [round: " + (round + 1) + "/" + maxRounds + "]";
        if (typeof lastMsg.content[lastMsg.content.length - 1] === "string") {
          (lastMsg.content[lastMsg.content.length - 1] as string) += stateHint;
        } else {
          (lastMsg.content as unknown[]).push({ type: "text", text: stateHint });
        }
      }

      this.log.info({ agent: this.name, round, state: currentState }, "LLM plan round");
      const response = await this.callLlmWithTools(messages, tools);

      const textBlocks: string[] = [];
      const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

      for (const block of response.content) {
        if (block.type === "text") {
          textBlocks.push(block.text ?? "");
        } else if (block.type === "tool_use") {
          toolCalls.push({ id: block.id!, name: block.name!, input: block.input! });
        }
      }

      for (const tc of toolCalls) {
        toolCallHistory.push(tc.name);
        if (tc.name === "search_weather") hasSearchedWeather = true;
        if (tc.name === "search_attractions") hasSearchedAttractions = true;
        if (tc.name === "search_restaurants") hasSearchedDining = true;
      }

      messages.push({ role: "assistant", content: response.content as unknown[] });

      if (toolCalls.length === 0) {
        const fullText = textBlocks.join("");
        const dayPlans = this.parsePlanResponse(fullText, days, dest.city, pref);
        const totalCost = dayPlans.reduce((sum, d) => sum + d.dayCost, 0);
        state.activityResult = { dayPlans, totalActivityCost: totalCost };
        this.log.info({ agent: this.name, days: dayPlans.length, totalCost }, "LLM行程生成完成");
        return state;
      }

      const toolResults: unknown[] = [];
      for (const tc of toolCalls) {
        const result = await this.executeTool(tc.name, tc.input, dest.city, pref);

        let contentStr = JSON.stringify(result);
        if (contentStr.length > 2000) {
          contentStr = JSON.stringify(this.truncateToolResult(tc.name, result));
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: tc.id,
          content: contentStr,
        });
      }
      messages.push({ role: "user", content: toolResults });

      messages = this.compressContext(messages, MAX_CONTEXT_CHARS, round);
    }

    this.log.warn({ agent: this.name }, "LLM plan agent exceeded max rounds, using fallback");
    return this.fallbackPlan(state, days, dest.city, pref);
  }

  private truncateToolResult(toolName: string, result: Record<string, unknown>): Record<string, unknown> {
    if (toolName === "search_attractions" && result.attractions) {
      const list = result.attractions as string;
      const lines = list.split("\n").slice(0, 5);
      return { ...result, attractions: lines.join("\n") + (lines.length < list.split("\n").length ? "\n...(已截断)" : "") };
    }
    if (toolName === "search_restaurants" && result.restaurants) {
      const list = result.restaurants as string;
      const lines = list.split("\n").slice(0, 4);
      return { ...result, restaurants: lines.join("\n") + (lines.length < list.split("\n").length ? "\n...(已截断)" : "") };
    }
    return result;
  }

  private compressContext(
    msgs: Array<{ role: "user" | "assistant"; content: string | unknown[] }>,
    maxChars: number,
    _round: number,
  ): Array<{ role: "user" | "assistant"; content: string | unknown[] }> {
    const totalLen = JSON.stringify(msgs).length;
    if (totalLen <= maxChars || msgs.length <= 3) return msgs;

    const keepHead = 1;
    const keepTail = 4;

    const head = msgs.slice(0, keepHead);
    const tail = msgs.slice(-keepTail);
    const middle = msgs.slice(keepHead, -keepTail);

    if (middle.length === 0) return msgs;

    const toolCounts: Record<string, number> = {};
    for (const m of middle) {
      if (m.role === "assistant" && Array.isArray(m.content)) {
        for (const block of m.content as Array<Record<string, unknown>>) {
          if (block.type === "tool_use" && block.name) {
            toolCounts[block.name as string] = (toolCounts[block.name as string] || 0) + 1;
          }
        }
      }
    }
    const summaryParts = Object.entries(toolCounts).map(([name, count]) => name + " x" + count);
    const summaryMsg = {
      role: "user" as const,
      content: "[上下文压缩] 已完成中间步骤：" + summaryParts.join(", ") + "。请基于已有信息继续规划。",
    };

    return [...head, summaryMsg, ...tail];
  }

  private buildToolDefs() {
    return [
      {
        name: "search_attractions",
        description: "搜索景点。可按城市+兴趣搜索泛结果，也可用 query 参数精确搜索指定景点名。",
        input_schema: {
          type: "object",
          properties: {
            city: { type: "string", description: "城市" },
            query: { type: "string", description: "精确景点名" },
            interests: { type: "array", items: { type: "string" }, description: "兴趣标签" },
            max_results: { type: "number", description: "最多返回数" },
          },
          required: ["city"],
        },
      },
      {
        name: "search_restaurants",
        description: "搜索当地特色餐厅。可指定餐型和偏好，返回推荐餐厅列表。",
        input_schema: {
          type: "object",
          properties: {
            city: { type: "string", description: "城市" },
            meal_type: { type: "string", enum: ["breakfast", "lunch", "dinner"], description: "餐型" },
            preference: { type: "string", enum: ["local_specialties", "trending", "mixed"], description: "餐饮偏好" },
            max_results: { type: "number", description: "最多返回数" },
          },
          required: ["city", "meal_type"],
        },
      },
      {
        name: "search_xhs_notes",
        description: "搜索小红书旅游笔记，获取真实游客的美食和游玩推荐。",
        input_schema: {
          type: "object",
          properties: {
            query: { type: "string", description: "搜索关键词" },
          },
          required: ["query"],
        },
      },
      {
        name: "search_weather",
        description: "查询指定城市的实时天气和未来天气预报。用于决定行程安排、穿衣建议、是否需要调整计划。",
        input_schema: {
          type: "object",
          properties: {
            city: { type: "string", description: "城市名" },
          },
          required: ["city"],
        },
      },
    ];
  }

  private async callLlmWithTools(
    messages: Array<{ role: string; content: string | unknown[] }>,
    tools: unknown[],
    sessionId?: string,
  ) {
    const body: Record<string, unknown> = {
      model: settings.LLM_MODEL,
      messages,
      tools,
      temperature: 0.7,
      max_tokens: 8192,
    };

    const sid = sessionId ?? getSessionId();
    if (sid) {
      sessionLogger.append(sid, "llm_request", {
        model: settings.LLM_MODEL,
        caller: "LLMPlanAgent",
        promptVersion: PROMPT_VERSION,
        tools: (tools as Array<Record<string, unknown>>).map((t) => t.name),
        messages: messages.map((m) => ({
          role: m.role,
          content: typeof m.content === "string"
            ? m.content.slice(0, 2000)
            : "[" + (m.content as unknown[]).length + " blocks]",
        })),
      });
    }

    const resp = await fetch(settings.LLM_BASE_URL + "/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": settings.LLM_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error("LLM Plan Agent API " + resp.status + ": " + err);
    }

    const data = await resp.json() as {
      content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
      stop_reason?: string;
    };

    if (sid) {
      sessionLogger.append(sid, "llm_response", {
        model: settings.LLM_MODEL,
        caller: "LLMPlanAgent",
        stopReason: data.stop_reason,
        toolCalls: data.content.filter((c) => c.type === "tool_use").map((c) => c.name),
        textLength: data.content.find((c) => c.type === "text")?.text?.length ?? 0,
      });
    }

    return data;
  }

  private async executeTool(name: string, input: Record<string, unknown>, city: string, pref: UserPreferences) {
    try {
      if (name === "search_weather") {
        try {
          const weatherSource = new AmapWeatherSource();
          const result = await weatherSource.getFullWeather(String(input.city ?? city));
          if (!result) return { success: true, weather: "天气数据暂不可用" };
          const lines: string[] = [];
          if (result.live) {
            lines.push("【当前天气】" + result.live.city + " " + result.live.weather
              + " " + result.live.temperature + "℃ " + result.live.winddirection + "风 " + result.live.windpower + "级");
          }
          if (result.forecast?.casts?.length) {
            lines.push("【未来天气预报】");
            for (const c of result.forecast.casts) {
              lines.push(c.date + " 白天:" + c.dayweather + " " + c.daytemp + "℃"
                + " 夜间:" + c.nightweather + " " + c.nighttemp + "℃"
                + " " + c.daywind + "风" + c.daypower + "级");
            }
          }
          return { success: true, weather: lines.join("\n") };
        } catch {
          return { success: true, weather: "天气查询失败" };
        }
      }

      if (name === "search_attractions") {
        const results = await this.dataSource.searchAttractions({
          city: String(input.city ?? city),
          query: input.query ? String(input.query) : undefined,
          interests: Array.isArray(input.interests) ? input.interests.map(String) : undefined,
          maxResults: Number(input.max_results) || 10,
        });
        const summary = results.slice(0, 12).map((a) =>
          a.name + " [" + a.category + "] ¥" + a.price + (a.geoLocation ? " (" + a.geoLocation.lat.toFixed(3) + "," + a.geoLocation.lon.toFixed(3) + ")" : "")
        ).join("\n");
        return { success: true, count: results.length, attractions: summary };
      }

      if (name === "search_restaurants") {
        const results = await this.dataSource.searchRestaurants({
          city: String(input.city ?? city),
          mealType: String(input.meal_type ?? "lunch") as "breakfast" | "lunch" | "dinner",
          diningPreference: (String(input.preference ?? "local_specialties")) as any,
          maxResults: Number(input.max_results) || 8,
        });
        const summary = results.slice(0, 8).map((r) => r.name + " ¥" + r.price + " " + (r.description || "")).join("\n");
        return { success: true, count: results.length, restaurants: summary };
      }

      if (name === "search_xhs_notes") {
        const query = String(input.query ?? city + "旅游攻略");
        try {
          const resp = await fetch("http://127.0.0.1:3220/search?q=" + encodeURIComponent(query) + "&limit=5", {
            signal: AbortSignal.timeout(15_000),
          });
          if (!resp.ok) return { success: true, notes: "XHS服务暂不可用" };
          const data = await resp.json() as { notes?: Array<{ title: string; content: string }> };
          const summary = (data.notes ?? []).map((n) => n.title + ": " + (n.content?.slice(0, 200) || "")).join("\n");
          return { success: true, notes: summary || "未找到相关笔记" };
        } catch {
          return { success: true, notes: "XHS服务暂不可用" };
        }
      }

      return { success: false, error: "Unknown tool: " + name };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }

  private parsePlanResponse(text: string, days: string[], city: string, pref: UserPreferences): DayPlan[] {
    try {
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("No JSON");
      const parsed = JSON.parse(match[0]) as {
        days?: Array<{ date: string; activities?: Array<Record<string, unknown>> }>;
      };
      if (!parsed.days?.length) throw new Error("Empty days");

      return parsed.days.map((d) => {
        const activities: Activity[] = (d.activities ?? []).map((a) => {
          const subtypeStr = String(a.subType ?? "attraction");
          return {
            name: String(a.name ?? ""),
            category: subtypeStr === "dining" ? "dining" : "sightseeing",
            location: city,
            durationHours: Number(a.durationHours ?? 2),
            price: Number(a.price ?? 0),
            rating: 8.0,
            description: String(a.description ?? ""),
            timeSlot: String(a.timeSlot ?? ""),
            subType: subtypeStr === "dining" ? ActivitySubType.DINING
              : subtypeStr === "transit" ? ActivitySubType.TRANSIT
              : ActivitySubType.ATTRACTION,
            mealType: a.mealType ? String(a.mealType) : undefined,
          } as Activity;
        });
        const dayCost = activities.reduce((s, a) => s + a.price, 0) * pref.numTravelers;
        return { date: d.date, activities, dayCost };
      });
    } catch (err) {
      this.log.warn({ err }, "Failed to parse LLM plan, using fallback");
      return this.fallbackPlanDays(days, city, pref);
    }
  }

  private fallbackPlan(state: TravelPlanState, days: string[], city: string, pref: UserPreferences): TravelPlanState {
    const dayPlans = this.fallbackPlanDays(days, city, pref);
    state.activityResult = { dayPlans, totalActivityCost: dayPlans.reduce((s, d) => s + d.dayCost, 0) };
    return state;
  }

  private fallbackPlanDays(days: string[], city: string, pref: UserPreferences): DayPlan[] {
    return days.map((date) => ({
      date,
      activities: [
        { name: city + "自由活动", category: "sightseeing", location: city, durationHours: 3, price: 100, rating: 8, description: date + " 上午自由活动", timeSlot: "morning", subType: ActivitySubType.ATTRACTION },
        { name: "当地餐厅", category: "dining", location: city, durationHours: 1.5, price: 60, rating: 8, description: date + " 午餐", timeSlot: "afternoon", subType: ActivitySubType.DINING, mealType: "lunch" },
        { name: city + "自由活动", category: "sightseeing", location: city, durationHours: 3, price: 100, rating: 8, description: date + " 下午自由活动", timeSlot: "afternoon", subType: ActivitySubType.ATTRACTION },
        { name: "当地餐厅", category: "dining", location: city, durationHours: 2, price: 80, rating: 8, description: date + " 晚餐", timeSlot: "evening", subType: ActivitySubType.DINING, mealType: "dinner" },
      ],
      dayCost: 340 * pref.numTravelers,
    }));
  }

  private getTravelDays(start: string, end: string): string[] {
    const d1 = new Date(start);
    const d2 = new Date(end);
    const count = Math.max(Math.round((d2.getTime() - d1.getTime()) / 86400000), 1);
    return Array.from({ length: count }, (_, i) => {
      const d = new Date(d1.getTime() + i * 86400000);
      return d.toISOString().slice(0, 10);
    });
  }
}
