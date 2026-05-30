import type { Logger } from "pino";
import {
  PlanningState,
  type Destination,
  type DestinationRecommendation,
  type TravelPlanState,
} from "../types/index.js";
import { BaseAgent } from "./base-agent.js";

const MOCK_DESTINATIONS: Destination[] = [
  { city: "东京", country: "日本", description: "传统与现代的完美融合，美食天堂", bestSeason: "spring,autumn", visaRequired: true, safetyScore: 9.5, costLevel: "high", highlights: ["浅草寺", "涩谷十字路口", "筑地市场", "东京塔"] },
  { city: "曼谷", country: "泰国", description: "热带风情，物美价廉的旅游胜地", bestSeason: "winter", visaRequired: false, safetyScore: 7.5, costLevel: "low", highlights: ["大皇宫", "卧佛寺", "考山路", "暹罗广场"] },
  { city: "巴黎", country: "法国", description: "浪漫之都，艺术与美食的殿堂", bestSeason: "spring,summer", visaRequired: true, safetyScore: 8.0, costLevel: "high", highlights: ["埃菲尔铁塔", "卢浮宫", "香榭丽舍大街", "蒙马特高地"] },
  { city: "清迈", country: "泰国", description: "宁静的兰纳古城，适合文化与休闲", bestSeason: "winter", visaRequired: false, safetyScore: 8.5, costLevel: "low", highlights: ["双龙寺", "古城", "夜间动物园", "周末夜市"] },
  { city: "首尔", country: "韩国", description: "潮流时尚与历史文化交汇", bestSeason: "spring,autumn", visaRequired: false, safetyScore: 9.0, costLevel: "medium", highlights: ["景福宫", "明洞", "北村韩屋村", "南山塔"] },
  { city: "大阪", country: "日本", description: "日本的厨房，环球影城所在地", bestSeason: "spring,autumn", visaRequired: true, safetyScore: 9.5, costLevel: "medium", highlights: ["大阪城", "道顿堀", "环球影城", "黑门市场"] },
];

export class DestinationAgent extends BaseAgent {
  readonly name = "DestinationAgent";
  constructor(log: Logger) { super(log); }

  protected async execute(state: TravelPlanState): Promise<TravelPlanState> {
    const pref = state.preferences;
    if (!pref) throw new Error("缺少用户偏好");

    let selected: Destination;

    if (pref.preferredDestination) {
      selected = await this.resolveByLlm(pref.preferredDestination, pref.budget);
    } else {
      selected = this.pickFromMock(pref.budget, pref.travelStyle, pref.startDate);
    }

    state.destinationRec = {
      destinations: [selected],
      selected,
      reasoning: pref.preferredDestination
        ? `根据您的偏好，推荐 ${selected.city}`
        : `根据您 ¥${pref.budget} 的预算和 ${pref.travelStyle} 风格，推荐 ${selected.city}`,
    };
    state.state = PlanningState.SEARCHING_PARALLEL;
    this.log.info({ agent: this.name, city: selected.city, country: selected.country }, "推荐目的地");
    return state;
  }

  private pickFromMock(budget: number, style: string, startDate: string): Destination {
    const scored: Array<[number, Destination]> = MOCK_DESTINATIONS.map((dest) => [
      DestinationAgent.scoreDestination(dest, budget, style, startDate),
      dest,
    ]);
    scored.sort((a, b) => b[0] - a[0]);
    return scored[0]![1];
  }

  private async resolveByLlm(city: string, budget: number): Promise<Destination> {
    const prompt = `请为旅行目的地"${city}"生成以下信息，严格以 JSON 格式返回（不要其他文字）：
{"city":"${city}","country":"国家","description":"一句话描述","bestSeason":"spring,summer,autumn或winter","visaRequired":false,"safetyScore":8.5,"costLevel":"low/medium/high","highlights":["景点1","景点2","景点3","景点4"]}

预算参考：${budget}元人民币。costLevel 应根据该城市的一般消费水平和预算匹配度来设定。safetyScore 范围 0-10。`;

    try {
      const raw = await this.callLlm(prompt);
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("no JSON");
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      return {
        city: String(parsed.city ?? city),
        country: String(parsed.country ?? ""),
        description: String(parsed.description ?? ""),
        bestSeason: String(parsed.bestSeason ?? "spring,autumn"),
        visaRequired: Boolean(parsed.visaRequired),
        safetyScore: Number(parsed.safetyScore) || 8.0,
        costLevel: String(parsed.costLevel ?? "medium"),
        highlights: Array.isArray(parsed.highlights) ? parsed.highlights.map(String) : [],
      };
    } catch {
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

  static scoreDestination(dest: Destination, budget: number, style: string, startDate: string): number {
    let score = 0;
    const costBudgetMap: Record<string, number> = { low: 8000, medium: 15000, high: 25000 };
    const estCost = costBudgetMap[dest.costLevel] ?? 15000;
    if (budget >= estCost) score += 30;
    else if (budget >= estCost * 0.7) score += 15;

    score += dest.safetyScore * 3;

    let month = 6;
    try { month = parseInt(startDate.slice(5, 7), 10) || 6; } catch { /* default */ }

    const seasonMap: Record<number, string> = {
      12: "winter", 1: "winter", 2: "winter",
      3: "spring", 4: "spring", 5: "spring",
      6: "summer", 7: "summer", 8: "summer",
      9: "autumn", 10: "autumn", 11: "autumn",
    };
    const currentSeason = seasonMap[month] ?? "summer";
    if (dest.bestSeason.includes(currentSeason)) score += 20;

    const styleCostPref: Record<string, string> = {
      budget: "low", comfort: "medium", luxury: "high",
      adventure: "low", cultural: "medium", relaxation: "medium",
    };
    if (styleCostPref[style] === dest.costLevel) score += 15;

    if (!dest.visaRequired) score += 10;
    return score;
  }
}
