import type { Logger } from "pino";
import { ActivitySubType, type Activity, type DayPlan, type TravelPlanState, type UserPreferences, type Train, type Flight, type Hotel } from "../types/index.js";
import type { TravelDataSource } from "../data-sources/types.js";
import { settings } from "../config/settings.js";
import { BaseAgent } from "./base-agent.js";
import { sessionLogger } from "../logging/session-logger.js";
import { getSessionId } from "../logging/session-context.js";
import { AmapWeatherSource } from "../data-sources/amap-weather-source.js";
import { WebSearchSource } from "../data-sources/web-search-source.js";

export class LLMPlanAgent extends BaseAgent {
  readonly name = "LLMPlanAgent";
  constructor(log: Logger, dataSource: TravelDataSource) { super(log, dataSource); }

  protected async execute(state: TravelPlanState): Promise<TravelPlanState> {
    const pref = state.preferences!;
    const dest = state.selectedDestination!;
    const days = this.getTravelDays(pref.startDate, pref.endDate);

    // Pre-fetch Baike city knowledge and weather for planning
    let cityKnowledge = "";
    try {
      const webSearch = new WebSearchSource(this.log);
      cityKnowledge = await webSearch.getCityKnowledge(dest.city);
      if (cityKnowledge) {
        this.log.info({ city: dest.city, len: cityKnowledge.length }, "city-knowledge: fetched for LLM plan");
      }
    } catch {
      // City knowledge unavailable, continue without it
    }

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
    const systemPrompt = this.buildSystemPrompt(pref, dest.city, days, weatherSummary, cityKnowledge);
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

  private buildSystemPrompt(pref: UserPreferences, city: string, days: string[], weatherSummary?: string, cityKnowledge?: string): string {
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

    const budgetStr = String(pref.budget);

    // ─── System Layer: 角色 + 不变规则 + 类型契约 ─────────────
    const systemLayer = [
      "# 角色",
      "你是资深旅行规划师。根据用户需求、实时天气、百科知识和搜索结果，生成可执行的每日行程。",
      "",
      "# 类型定义（严格遵守）",
      "",
      "```typescript",
      "type SubType = \"attraction\" | \"dining\" | \"transit\";",
      "type TimeSlot = \"morning\" | \"afternoon\" | \"evening\";",
      "type MealType = \"breakfast\" | \"lunch\" | \"dinner\";",
      "",
      "type Activity = {",
      "  name: string;           // 景点/餐厅/交通名称",
      '  subType: SubType;       // 唯一分类（见下方规则）',
      '  timeSlot: TimeSlot;     // 时段（morning=6-12, afternoon=12-18, evening=18-）',
      "  durationHours: number;  // 耗时（0.5的倍数）",
      "  price: number;          // 单人价格，0=免费",
      "  description: string;    // 不少于30字，含推荐理由/路线/天气提醒",
      "  mealType?: MealType;    // 仅 dining 类型需要",
      "};",
      "",
      "type DayPlan = {",
      "  date: string;           // YYYY-MM-DD",
      "  theme: string;          // 当日主题，如\"故宫·天安门\"",
      "  activities: Activity[]; // 完整活动链（含 transit 衔接）",
      "};",
      "",
      "type Itinerary = {",
      "  days: DayPlan[];",
      "  estimatedTotalCost: number;  // 所有 price 之和 × numTravelers",
      '  warnings?: string[];         // 降级/不确定信息标注',
      "};",
      "```",
      "",
      "# 规划规则",
      "",
      "## 景点覆盖",
      "- 必去景点必须全部出现在行程中，逐一检查：" + mustVisit,
      "- 同区域景点安排同一天，避免跨区折返跑",
      "",
      "## 首末日",
      "- 抵达日：根据到达时间动态调整。下午到→只排下午+晚上，预留入住休整",
      "- 离开日：至少提前2小时去车站，最多排上午活动，不排晚餐",
      "",
      "## 预算",
      "- 所有 activities.price 之和 × " + pref.numTravelers + " ≤ ¥" + budgetStr,
      "- 超预算时：降餐厅档次或跳过收费景点的付费项目",
      "- estimatedTotalCost 反映估算总花费",
      "",
      "## 交通",
      "- 每个活动前后都要有 transit 衔接（首活动从酒店出发，末活动返回酒店）",
      "- transit.name = \"起点 → 终点（方式）\"",
      "- transit.price = 预估交通费（地铁≈5, 出租≈30, 公交≈2）",
      "- transit.durationHours = 路途时间",
      "- transit.description = \"从XX到YY，地铁X号线，约N分钟\"",
      "",
      "## 餐饮",
      "- 只推荐当地特色，如" + cuisine + "。禁止连锁快餐（麦当劳/肯德基等）",
      "- description：招牌菜 + 推荐理由",
      "",
      "## 天气",
      "- 雨天/大风→室内活动；高温>35℃→减少暴晒；低温<5℃→提醒带外套",
      "- 极端天气（暴雨/暴雪/台风）→建议调整当日行程",
      "- 在 activity.description 中标注天气提醒和穿衣建议",
      "",
    ].join("\n");

    // ─── Context Layer: 用户信息 + 天气 + 百科 ───────────────
    const contextLayer = [
      "# 当前行程上下文",
      "",
      "## 用户信息",
      "- 出发城市：" + pref.departureCity + "  →  目的地：" + city,
      "- 日期：" + haveDates + "  |  人数：" + pref.numTravelers + "人",
      "- 总预算：¥" + budgetStr,
      "- 兴趣：" + (pref.interests.join("、") || "无特别指定"),
      "- 必去景点：" + mustVisit,
      transportLines,
      hotelLine,
      weatherSummary ? "\n## 天气预报\n" + weatherSummary : "",
      cityKnowledge ? "\n## 目的地百科（百度百科）\n" + cityKnowledge.slice(0, 2500) : "",
      "",
    ].filter(Boolean).join("\n");

    // ─── Task Layer: ReAct 指令 + 自检清单 + few-shot ─────────
    const taskLayer = [
      "# 执行流程",
      "",
      "## 阶段一：ReAct 推理循环",
      "",
      "逐轮执行以下三步骤，直到信息足够：",
      "",
      "Thought — 分析：已知什么？缺什么？下一步该做什么？",
      "Action  — 调用一个工具（search_weather / search_attractions / search_restaurants / search_xhs_notes）",
      "（Observation 自动返回）",
      "",
      "参考路径：",
      "  第1轮  Thought: " + city + "天气如何？必去景点" + mustVisit + "先查具体信息",
      "        Action: search_weather + 对必去景点逐个 search_attractions",
      "  第2轮  Thought: 查到了哪些？还缺哪个必去景点？",
      "        Action: 补查缺失景点 或 开始查餐厅",
      "  第3轮  Thought: 景点齐全，开始查餐厅和小红书",
      "        Action: search_restaurants（早/午/晚餐）+ search_xhs_notes",
      "  第N轮  Thought: 信息足够，综合编排行程",
      "        Action: 进入阶段二",
      "",
      "## 阶段二：输出前自检",
      "",
      "输出 JSON 前逐项检查，不满足则继续收集信息：",
      "",
      "- [ ] 必去景点逐一检查：" + mustVisit + " 全部覆盖？",
      "- [ ] 总费用是否 ≤ ¥" + budgetStr + "？",
      "- [ ] 首日/末日是否按抵达/离开时间处理？",
      "- [ ] 每天 2-3 个景点 + 3 餐 + transit 衔接完整？",
      "- [ ] transit 夹在相邻活动之间（首活动从酒店出发，末活动返回酒店）？",
      "- [ ] 大雨/恶劣天气的活动是否已改为室内？",
      "",
      "自检通过后，输出 Itinerary 类型的纯 JSON，不要有其他文字。",
      "",
      "## 降级说明",
      "- 天气查询失败：继续规划，在 warnings 中注明\"天气数据不可用\"",
      "- 景点搜索失败：用内置知识补全，在 description 中标注\"建议出发前确认\"",
      "- 餐厅搜索失败：推荐当地特色菜系中的经典品类，标注\"建议到地后再选具体餐厅\"",
      "- 其他工具失败：不影响主流程，在 warnings 中记录",
      "",
    ].join("\n");

    return systemLayer + "\n" + contextLayer + "\n" + taskLayer;
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
