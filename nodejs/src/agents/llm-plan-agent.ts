import type { Logger } from "pino";
import { ActivitySubType, type Activity, type DayPlan, type TravelPlanState, type UserPreferences, type Train, type Flight, type Hotel } from "../types/index.js";
import type { TravelDataSource } from "../data-sources/types.js";
import { settings } from "../config/settings.js";
import { BaseAgent } from "./base-agent.js";
import { sessionLogger } from "../logging/session-logger.js";
import { getSessionId } from "../logging/session-context.js";
import { AmapWeatherSource } from "../data-sources/amap-weather-source.js";

export class LLMPlanAgent extends BaseAgent {
  readonly name = "LLMPlanAgent";
  constructor(log: Logger, dataSource: TravelDataSource) { super(log, dataSource); }

  protected async execute(state: TravelPlanState): Promise<TravelPlanState> {
    const pref = state.preferences!;
    const dest = state.selectedDestination!;
    const days = this.getTravelDays(pref.startDate, pref.endDate);

    // Pre-fetch weather for planning
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
    } catch {
      // Weather unavailable, continue without it
    }

    const tools = this.buildToolDefs();
    const systemPrompt = this.buildSystemPrompt(pref, dest.city, days, weatherSummary);
    const messages: Array<{ role: "user" | "assistant"; content: string | unknown[] }> = [
      { role: "user", content: systemPrompt },
    ];

    const maxRounds = 10;
    for (let round = 0; round < maxRounds; round++) {
      this.log.info({ agent: this.name, round }, "LLM plan round");
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
        toolResults.push({
          type: "tool_result",
          tool_use_id: tc.id,
          content: JSON.stringify(result),
        });
      }
      messages.push({ role: "user", content: toolResults });
    }

    this.log.warn({ agent: this.name }, "LLM plan agent exceeded max rounds, using fallback");
    return this.fallbackPlan(state, days, dest.city, pref);
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

  private buildSystemPrompt(pref: UserPreferences, city: string, days: string[], weatherSummary?: string): string {
    const transportLines = this.formatTransport(pref);
    const hotelLine = this.formatHotel(pref);
    const mustVisit = pref.mustVisitAttractions?.length
      ? pref.mustVisitAttractions.join("、") : "无";

    const hotelName = pref.selectedHotel
      ? (pref.selectedHotel as Record<string, unknown>).name || "已选"
      : "待定";

    const haveDates = days.join("、");

    const cuisineSamples: Record<string, string> = {
      "北京": "烤鸭、涮肉、炸酱面、豆汁儿",
      "成都": "火锅、串串、川菜、担担面",
      "西安": "羊肉泡馍、凉皮、肉夹馍",
      "广州": "早茶、烧腊、肠粉",
    };
    const cuisine = cuisineSamples[city] || "当地特色菜系";

    return [
      "你是一位资深旅行规划师。请为用户生成" + city + days.length + "日详细行程。",
      "",
      "## 用户信息",
      "- 出发城市：" + pref.departureCity,
      "- 目的地：" + city,
      "- 日期：" + haveDates,
      "- 人数：" + pref.numTravelers + "人",
      "- 总预算：¥" + pref.budget,
      "- 兴趣：" + (pref.interests.join("、") || "无特别指定"),
      "- 必去景点：" + mustVisit,
      "- 餐饮偏好：" + (pref.diningPreference === "local_specialties" ? "当地特色美食" : pref.diningPreference),
      transportLines,
      hotelLine,
      weatherSummary ? "\n## 天气预报\n" + weatherSummary : "",
      "## 核心规则（严格遵守）",
      "",
      "### 1. 必去景点完整覆盖",
      "用户指定的 " + mustVisit + " 全部必须出现在行程中，不能遗漏任何一个。",
      "",
      "### 2. 酒店位置合理性",
      "- 用户已选择酒店：" + hotelName,
      "- 重要：所有行程的返回酒店路线，交通时间必须合理（建议单程不超过1小时）",
      "- 如果酒店距市中心较远，应将酒店附近的活动安排在同一天，减少往返奔波",
      "- 地理聚合：同区域景点安排同一天，避免跨区折返跑",
      "",
      "### 3. 日程节奏",
      "- 每天应包含：早餐 -> 上午景点 -> 午餐 -> 下午景点 -> 晚餐 -> 返回酒店",
      "- 每天合理活动量：2-3个景点加3餐，不要排太满",
      "- 景点开放时间：注意景点开放时间，故宫/雍和宫等下午4-5点关门",
      "- 大型景点（故宫、环球影城）至少留半天",
      "",
      "### 4. 交通细节",
      "- 每次活动之间要包含 transit 类型的交通衔接",
      "- 详细说明出行方式：地铁X号线（推荐优先）、公交、打车（短途）、步行/骑行（<2km）",
      "- 交通 description 格式：从起点到终点，地铁X号线，预计XX分钟",
      "- 景点附近的替代交通方案可写在 description 中",
      "",
      "### 5. 餐饮推荐",
      "- 只推荐当地特色餐厅，如" + cuisine,
      "- 禁止推荐：麦当劳、肯德基、必胜客、星巴克等连锁快餐",
      "- description 写清楚推荐理由和招牌菜",
      "",
      "### 6. 天气与衣物建议",
      "- 根据天气预报合理安排每日行程",
      "- 雨天/大风天：优先安排室内活动（博物馆、国博、商场），避免户外长时间活动",
      "- 高温天（>35℃）：减少户外暴晒景点，多安排室内或有遮阴的活动",
      "- 低温天（<5℃）：增加室内暖和地方，提醒携带外套",
      "- 在活动的 description 中标注天气提醒和穿衣建议",
      "- 如果天气极端恶劣（暴雨、台风、暴雪），应建议用户调整当日行程",
      "",
      "### 7. 输出JSON格式",
      "subType 取值为：attraction | dining | transit",
      "timeSlot 取值为：morning | afternoon | evening",
      "price：单人价格（元），景点0表示免费",
      "description：详细描述活动内容、推荐理由、路线指引",
      "durationHours：预估耗时（小时）",
      "",
      "## 工作流程",
      "1. 先调用 search_weather 查询目的地天气预报",
      "2. 对每个必去景点，调用 search_attractions 精确搜索",
      "3. 按兴趣标签搜索更多景点",
      "4. 为早/午/晚餐搜索当地特色餐厅",
      "5. 可选调用 search_xhs_notes 获取当地美食/游玩真实推荐",
      "6. 综合天气、景点、餐厅信息编制行程",
      "",
      "## 输出JSON",
      "{",
      '  "days": [',
      "    {",
      '      "date": "' + days[0] + '",',
      '      "activities": [',
      '        {"name":"名称","subType":"attraction或dining或transit","timeSlot":"morning或afternoon或evening","durationHours":2.5,"price":60,"description":"详细描述","category":"景点或dining或transit"}',
      "      ]",
      "    }",
      "  ]",
      "}",
      "",
      "只输出纯JSON，不要有其他文字。",
    ].filter(Boolean).join("\n");
  }

  private formatTransport(pref: UserPreferences): string {
    const parts: string[] = [];
    for (const [label, t] of [["去程", pref.selectedOutbound], ["返程", pref.selectedReturn]] as const) {
      if (!t) continue;
      if ("trainNo" in t) {
        const tr = t as Train;
        parts.push(label + "：" + tr.trainNo + " " + tr.departureCity + "->" + tr.arrivalCity + " " + tr.departureTime + "-" + tr.arrivalTime + " ¥" + tr.price + "/人");
      } else {
        const fl = t as Flight;
        parts.push(label + "：" + fl.flightNo + " " + fl.departureCity + "->" + fl.arrivalCity + " " + fl.departureTime + "-" + fl.arrivalTime + " ¥" + fl.price + "/人");
      }
    }
    return parts.length ? "\n## 交通\n" + parts.join("\n") : "";
  }

  private formatHotel(pref: UserPreferences): string {
    if (!pref.selectedHotel) return "";
    const h = pref.selectedHotel as Hotel;
    return "\n## 酒店\n" + h.name + " " + h.starRating + "星 ¥" + h.pricePerNight + "/晚";
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
        const activities: Activity[] = (d.activities ?? []).map((a) => ({
          name: String(a.name ?? ""),
          category: String(a.category ?? "sightseeing"),
          location: city,
          durationHours: Number(a.durationHours ?? 2),
          price: Number(a.price ?? 0),
          rating: 8.0,
          description: String(a.description ?? ""),
          timeSlot: String(a.timeSlot ?? ""),
          subType: a.subType === "dining" ? ActivitySubType.DINING
            : a.subType === "transit" ? ActivitySubType.TRANSIT
            : ActivitySubType.ATTRACTION,
          mealType: a.mealType ? String(a.mealType) : undefined,
        }));
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
