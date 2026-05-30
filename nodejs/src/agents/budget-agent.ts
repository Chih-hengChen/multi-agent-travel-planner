import type { Logger } from "pino";
import { PlanningState, type BudgetBreakdown, type TravelPlanState } from "../types/index.js";
import { BaseAgent } from "./base-agent.js";

export class BudgetAgent extends BaseAgent {
  readonly name = "BudgetAgent";
  constructor(log: Logger) { super(log); }

  protected async execute(state: TravelPlanState): Promise<TravelPlanState> {
    const pref = state.preferences;
    if (!pref) throw new Error("缺少用户偏好");

    const flightCost = state.flightResult?.totalFlightCost ?? 0;
    const hotelCost = state.hotelResult?.totalHotelCost ?? 0;
    const activityCost = state.activityResult?.totalActivityCost ?? 0;

    const total = flightCost + hotelCost + activityCost;
    const remaining = pref.budget - total;
    const withinBudget = remaining >= 0;
    const overAmount = Math.max(0, -remaining);

    const suggestions = !withinBudget
      ? BudgetAgent.generateSuggestions(overAmount, flightCost, hotelCost, activityCost, state.adjustmentRound)
      : [];

    const breakdown: BudgetBreakdown = {
      flightCost, hotelCost, activityCost, totalCost: total,
      budget: pref.budget, remaining, isWithinBudget: withinBudget,
      overBudgetAmount: overAmount, suggestions,
    };
    state.budgetBreakdown = breakdown;

    if (withinBudget) {
      state.state = PlanningState.COMPLETED;
      this.log.info({ agent: this.name, total, remaining }, "预算通过");
    } else if (state.adjustmentRound < state.maxAdjustments) {
      state.state = PlanningState.ADJUSTING;
      state.adjustmentRound++;
      BudgetAgent.applyAdjustments(state);
      this.log.warn({ agent: this.name, overAmount, round: state.adjustmentRound }, "超预算，进入调整");
    } else {
      state.state = PlanningState.COMPLETED;
      state.errorMessages.push(`经过 ${state.maxAdjustments} 轮调整仍超预算 ¥${overAmount.toFixed(0)}，返回当前最优方案`);
      this.log.warn({ agent: this.name }, "达到最大调整次数");
    }

    return state;
  }

  static generateSuggestions(over: number, flight: number, hotel: number, activity: number, roundNum: number): string[] {
    const s: string[] = [];
    if (roundNum === 0) {
      s.push(`减少活动开支约 ¥${Math.min(over, activity * 0.3).toFixed(0)}（选择免费景点）`);
      s.push("选择评分略低但更实惠的餐厅");
    } else if (roundNum === 1) {
      s.push(`降低酒店等级，节省约 ¥${Math.min(over, hotel * 0.3).toFixed(0)}`);
      s.push("考虑距离市中心稍远但性价比更高的酒店");
    } else {
      s.push(`选择更经济的航班，节省约 ¥${Math.min(over, flight * 0.2).toFixed(0)}`);
      s.push("考虑中转航班替代直飞");
      s.push("缩短行程天数");
    }
    return s;
  }

  static applyAdjustments(state: TravelPlanState): void {
    const roundNum = state.adjustmentRound;
    const over = state.budgetBreakdown?.overBudgetAmount ?? 0;

    if (roundNum === 1 && state.activityResult) {
      const cutRatio = Math.min(0.4, over / Math.max(state.activityResult.totalActivityCost, 1));
      for (const day of state.activityResult.dayPlans) {
        for (const act of day.activities) act.price *= (1 - cutRatio);
        day.dayCost *= (1 - cutRatio);
      }
      state.activityResult.totalActivityCost *= (1 - cutRatio);
    } else if (roundNum === 2 && state.hotelResult?.recommended) {
      const cutRatio = Math.min(0.35, over / Math.max(state.hotelResult.totalHotelCost, 1));
      state.hotelResult.recommended.pricePerNight *= (1 - cutRatio);
      state.hotelResult.totalHotelCost *= (1 - cutRatio);
    } else if (roundNum >= 3 && state.flightResult) {
      const cutRatio = Math.min(0.25, over / Math.max(state.flightResult.totalFlightCost, 1));
      if (state.flightResult.recommendedOutbound) state.flightResult.recommendedOutbound.price *= (1 - cutRatio);
      if (state.flightResult.recommendedReturn) state.flightResult.recommendedReturn.price *= (1 - cutRatio);
      state.flightResult.totalFlightCost *= (1 - cutRatio);
    }
  }
}
