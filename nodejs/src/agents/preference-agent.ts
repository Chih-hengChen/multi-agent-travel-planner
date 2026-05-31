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
    state.state = PlanningState.RECOMMENDING_DESTINATIONS;
    return state;
  }
}
