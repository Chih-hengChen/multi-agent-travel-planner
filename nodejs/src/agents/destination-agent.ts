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

    const scored: Array<[number, Destination]> = MOCK_DESTINATIONS.map((dest) => [
      DestinationAgent.scoreDestination(dest, pref.budget, pref.travelStyle, pref.startDate),
      dest,
    ]);

    scored.sort((a, b) => b[0] - a[0]);
    const top3 = scored.slice(0, 3).map(([, d]) => d);
    const selected = top3[0]!;

    state.destinationRec = {
      destinations: top3,
      selected,
      reasoning: `根据您 ¥${pref.budget} 的预算和 ${pref.travelStyle} 风格，推荐 ${selected.city}`,
    };
    state.state = PlanningState.SEARCHING_PARALLEL;
    this.log.info({ agent: this.name, city: selected.city, country: selected.country }, "推荐目的地");
    return state;
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
