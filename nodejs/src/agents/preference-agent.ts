import type { Logger } from "pino";
import { PlanningState, type TravelPlanState } from "../types/index.js";
import { BaseAgent } from "./base-agent.js";

export class PreferenceAgent extends BaseAgent {
  readonly name = "PreferenceAgent";
  constructor(log: Logger) { super(log); }

  protected async execute(state: TravelPlanState): Promise<TravelPlanState> {
    if (state.preferences === null) {
      throw new Error("用户偏好未提供，请先设置 state.preferences");
    }
    const pref = state.preferences;
    if (pref.interests.length === 0) {
      pref.interests = PreferenceAgent.defaultInterests(pref.travelStyle);
      this.log.info({ agent: this.name, interests: pref.interests }, "自动补充兴趣标签");
    }
    state.state = PlanningState.RECOMMENDING_DESTINATIONS;
    return state;
  }

  static defaultInterests(style: string): string[] {
    const mapping: Record<string, string[]> = {
      budget: ["免费景点", "街头美食", "步行游览"],
      comfort: ["经典景点", "当地美食", "文化体验"],
      luxury: ["米其林餐厅", "私人导游", "SPA"],
      adventure: ["徒步", "潜水", "极限运动"],
      cultural: ["博物馆", "历史遗迹", "传统手工艺"],
      relaxation: ["海滩", "温泉", "瑜伽"],
    };
    return mapping[style] ?? ["经典景点", "美食"];
  }
}
