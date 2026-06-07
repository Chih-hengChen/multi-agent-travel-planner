import type { UserPreferences } from "../types/index.js";

/**
 * Prompt version tracking.
 * Bump this when prompt structure or rules change significantly.
 * Format: YYYYMMDD.N where N is the revision within that day.
 * Logged in every llm_request trace for reproducibility.
 */
export const PROMPT_VERSION = "20260607.1";

export function buildSystemPrompt(
  pref: UserPreferences,
  city: string,
  days: string[],
  weatherSummary?: string,
  cityKnowledge?: string,
): string {
  const mustVisit = pref.mustVisitAttractions?.length
    ? pref.mustVisitAttractions.join("、") : "无";
  const hotelName = pref.selectedHotel
    ? (pref.selectedHotel as Record<string, unknown>).name || "已选"
    : "待定";
  const transportLines = formatTransport(pref);
  const hotelLine = formatHotel(pref);
  const haveDates = days.join("、");

  const cuisineSamples: Record<string, string> = {
    "北京": "烤鸭、涮肉、炸酱面、豆汁儿",
    "成都": "火锅、串串、川菜、担担面",
    "西安": "羊肉泡馍、凉皮、肉夹馍",
    "广州": "早茶、烧腊、肠粉",
  };
  const cuisine = cuisineSamples[city] || "当地特色菜系";
  const budgetStr = String(pref.budget);

  // ─── System Layer ─────────────
  const systemLayer = [
    "# 角色",
    "你是资深旅行规划师。根据用户需求、实时天气、百科知识和搜索结果，生成可执行的每日行程。",
    "[prompt v" + PROMPT_VERSION + "]",
    "",
    "# 类型定义（严格遵守）",
    "",
    "type SubType = \"attraction\" | \"dining\" | \"transit\";",
    "type TimeSlot = \"morning\" | \"afternoon\" | \"evening\";",
    "type MealType = \"breakfast\" | \"lunch\" | \"dinner\";",
    "",
    "type Activity = {",
    "  name: string;           // 景点/餐厅/交通名称",
    "  subType: SubType;       // 唯一分类",
    "  timeSlot: TimeSlot;     // 时段（morning=6-12, afternoon=12-18, evening=18-）",
    "  durationHours: number;  // 耗时（0.5的倍数）",
    "  price: number;          // 单人价格，0=免费",
    "  description: string;    // 不少于30字，含推荐理由/路线/天气提醒",
    "  mealType?: MealType;    // 仅 dining 需要",
    "};",
    "",
    "type DayPlan = {",
    "  date: string;",
    "  theme: string;",
    "  activities: Activity[];",
    "};",
    "",
    "type Itinerary = {",
    "  days: DayPlan[];",
    "  estimatedTotalCost: number;",
    "  warnings?: string[];",
    "};",
    "",
    "# 旅行攻略知识库",
    "",
    "你可调用 search_travel_guides 访问全国旅行攻略语料库（蚂蜂窝、穷游、百科等）。",
    "vs search_attractions：后者返回实时景点列表（名称/价格/坐标）；前者返回深度攻略段落（路线/贴士/最佳时间）。",
    "先用 search_attractions 列候选，再用 search_travel_guides 深入了解「怎么玩」。",
    "需要路线推荐、小众景点、避坑指南时优先使用。",
    "",
    "# 规则",
    "",
    "## 景点覆盖",
    "- 必去景点必须全部出现在行程中，逐一检查：" + mustVisit,
    "- 同区域景点安排同一天",
    "",
    "## 首末日",
    "- 抵达日：根据到达时间动态调整。下午到→只排下午+晚上",
    "- 离开日：提前2小时去车站，最多排上午，不排晚餐",
    "",
    "## 预算",
    "- 所有 activities.price 之和 × " + pref.numTravelers + " ≤ ¥" + budgetStr,
    "- estimatedTotalCost 反映估算总花费",
    "",
    "## 交通",
    "- 每个活动前后都要有 transit 衔接（首活动从酒店出发，末活动返回酒店）",
    '- transit.name = "起点 → 终点（方式）"',
    "- transit.price = 预估交通费（地铁≈5, 出租≈30, 公交≈2）",
    "- transit.durationHours = 路途时间",
    "",
    "## 餐饮",
    "- 只推荐当地特色，如" + cuisine + "。禁止连锁快餐",
    "- description：招牌菜 + 推荐理由",
    "",
    "## 天气",
    "- 雨天→室内；高温>35℃→减少暴晒；低温<5℃→提醒带外套",
    "- 极端天气→建议调整行程",
    "- 在 activity.description 中标注天气提醒和穿衣建议",
    "",
  ].join("\n");

  // ─── Context Layer ───────────────
  const contextLayer = [
    "# 当前行程上下文",
    "",
    "## 用户信息",
    "- 出发：" + pref.departureCity + "  →  目的地：" + city,
    "- 日期：" + haveDates + "  |  人数：" + pref.numTravelers + "人",
    "- 总预算：¥" + budgetStr,
    "- 兴趣：" + (pref.interests.join("、") || "无"),
    "- 必去：" + mustVisit,
    transportLines,
    hotelLine,
    weatherSummary ? "\n## 天气\n" + weatherSummary : "",
    cityKnowledge ? "\n## 百科\n" + cityKnowledge.slice(0, 2500) : "",
    "",
  ].filter(Boolean).join("\n");

  // ─── Task Layer ───────────────
  const taskLayer = [
    "# 执行流程",
    "",
    "## 阶段一：ReAct 推理循环",
    "",
    "逐轮执行以下三步骤，直到信息足够：",
    "",
    "Thought — 分析：已知什么？缺什么？下一步该做什么？",
    "Action — 调用工具",
    "（Observation 自动返回）",
    "",
    "参考路径：",
    "  第1轮  Thought: " + city + "天气？必去" + mustVisit + "查信息 + 攻略库推荐",
    "        Action: search_weather + search_attractions + search_travel_guides(city, \"必去景点\")",
    "  第2轮  Thought: 还缺哪个必去景点？",
    "        Action: 补查景点 / 查餐厅",
    "  第3轮  Thought: 景点齐全，查餐厅和小红书",
    "        Action: search_restaurants + search_xhs_notes",
    "  第N轮  Thought: 信息足够，编排行程",
    "        Action: 进入阶段二",
    "",
    "## 阶段二：输出前自检",
    "",
    "- [ ] 必去景点逐一检查：" + mustVisit + " 全部覆盖？",
    "- [ ] 总费用 ≤ ¥" + budgetStr + "？",
    "- [ ] 首日/末日按抵达/离开时间处理？",
    "- [ ] 每天 2-3 景点 + 3 餐 + transit 完整？",
    "- [ ] transit 夹在相邻活动之间？",
    "- [ ] 恶劣天气已改为室内活动？",
    "",
    "自检通过后，输出 Itinerary 类型的纯 JSON。",
    "",
  ].join("\n");

  return systemLayer + "\n" + contextLayer + "\n" + taskLayer;
}

function formatTransport(pref: UserPreferences): string {
  const parts: string[] = [];
  for (const [label, t] of [["去程", pref.selectedOutbound], ["返程", pref.selectedReturn]] as const) {
    if (!t) continue;
    if ("trainNo" in t) {
      const tr = t as Record<string, unknown>;
      parts.push(label + "：" + tr.trainNo + " " + tr.departureCity + "->" + tr.arrivalCity + " " + tr.departureTime + "-" + tr.arrivalTime + " ¥" + tr.price + "/人");
    } else {
      const fl = t as Record<string, unknown>;
      parts.push(label + "：" + fl.flightNo + " " + fl.departureCity + "->" + fl.arrivalCity + " " + fl.departureTime + "-" + fl.arrivalTime + " ¥" + fl.price + "/人");
    }
  }
  return parts.length ? "\n## 交通\n" + parts.join("\n") : "";
}

function formatHotel(pref: UserPreferences): string {
  if (!pref.selectedHotel) return "";
  const h = pref.selectedHotel as Record<string, unknown>;
  return "\n## 酒店\n" + h.name + " " + h.starRating + "星 ¥" + h.pricePerNight + "/晚";
}
