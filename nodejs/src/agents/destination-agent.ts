import type { Logger } from "pino";
import {
  PlanningState,
  type Destination,
  type DestinationRecommendation,
  type TravelPlanState,
} from "../types/index.js";
import { BaseAgent } from "./base-agent.js";

export class DestinationAgent extends BaseAgent {
  readonly name = "DestinationAgent";
  constructor(log: Logger) { super(log); }

  protected async execute(state: TravelPlanState): Promise<TravelPlanState> {
    const pref = state.preferences;
    if (!pref) throw new Error("缺少用户偏好");

    const target = pref.preferredDestination || "";
    if (!target) throw new Error("请指定旅行目的地");

    const selected = await this.resolveByLlm(target, pref.budget);

    state.destinationRec = {
      destinations: [selected],
      selected,
      reasoning: `根据您的偏好，推荐 ${selected.city}`,
    };
    state.state = PlanningState.SEARCHING_PARALLEL;
    this.log.info({ agent: this.name, city: selected.city, country: selected.country }, "推荐目的地");
    return state;
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
}
