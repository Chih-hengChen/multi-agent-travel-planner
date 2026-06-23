import type { Logger } from "pino";
import { PlanningState, type BudgetBreakdown, type SearchConstraints, type TravelPlanState, type UserPreferences } from "../types/index.js";
import type { TravelDataSource } from "../data-sources/types.js";
import { BaseAgent } from "./base-agent.js";

export class BudgetAgent extends BaseAgent {
  readonly name = "BudgetAgent";
  constructor(log: Logger, dataSource: TravelDataSource) { super(log, dataSource); }

  protected async execute(state: TravelPlanState): Promise<TravelPlanState> {
    const pref = state.preferences!;
    const flightCost = state.flightResult?.totalFlightCost ?? 0;
    const trainCost = state.transportMode === "train" && state.trainOutbound && state.trainReturn
      ? (state.trainOutbound.price + state.trainReturn.price) * pref.numTravelers
      : 0;
    const hotelCost = state.hotelResult?.totalHotelCost ?? 0;
    const activityCost = state.activityResult?.totalActivityCost ?? 0;

    const total = flightCost + trainCost + hotelCost + activityCost;
    const remaining = pref.budget - total;
    const withinBudget = remaining >= 0;
    const overAmount = Math.max(0, -remaining);

    const suggestions = !withinBudget
      ? BudgetAgent.generateSuggestions(overAmount, flightCost, hotelCost, activityCost, state.adjustmentRound)
      : [];

    const breakdown: BudgetBreakdown = {
      flightCost, trainCost, hotelCost, activityCost, totalCost: total,
      budget: pref.budget, remaining, isWithinBudget: withinBudget,
      overBudgetAmount: overAmount, suggestions,
    };
    state.budgetBreakdown = breakdown;

    if (withinBudget) {
      state.state = PlanningState.COMPLETED;
      this.log.info({ agent: this.name, total, remaining }, "预算通过");
    } else if (BudgetAgent.isWithinFlexBudget(pref, total) && pref.budgetStrictness !== "strict") {

      state.state = PlanningState.COMPLETED;
      this.log.info({ agent: this.name, total, remaining, strictness: pref.budgetStrictness }, "灵活预算，允许小幅超标");
    } else if (state.adjustmentRound < state.maxAdjustments) {
      state.state = PlanningState.ADJUSTING;
      state.adjustmentRound++;
      state.searchConstraints = BudgetAgent.computeConstraints(state);
      this.log.warn({
        agent: this.name,
        overAmount,
        round: state.adjustmentRound,
        constraints: state.searchConstraints,
      }, "超预算，设置约束条件重新搜索");
    } else {
      state.state = PlanningState.COMPLETED;
      state.errorMessages.push(`经过 ${state.maxAdjustments} 轮调整仍超预算 ¥${overAmount.toFixed(0)}，返回当前最优方案`);
      this.log.warn({ agent: this.name }, "达到最大调整次数");
    }

    return state;
  }

  static isWithinFlexBudget(pref: UserPreferences, total: number): boolean {
    const limits: Record<string, number> = { flexible: 1.15, luxury: 1.30 };
    const ratio = limits[pref.budgetStrictness] ?? 1.0;
    return total <= pref.budget * ratio;
  }

  static computeConstraints(state: TravelPlanState): SearchConstraints {
    const pref = state.preferences!;
    const nights = Math.max(1, Math.round(
      (new Date(pref.endDate).getTime() - new Date(pref.startDate).getTime()) / 86400000,
    ));
    const days = nights;
    const round = state.adjustmentRound;

    const targetFlight = pref.budget * 0.30;
    const targetHotel = pref.budget * 0.40;
    const targetActivity = pref.budget * 0.30;

    if (round === 1) {
      return {
        maxActivityCostPerDay: (targetActivity / days) * 0.85,
        maxHotelPricePerNight: targetHotel / nights,
      };
    }

    if (round === 2) {
      return {
        maxActivityCostPerDay: (targetActivity / days) * 0.70,
        maxHotelPricePerNight: (targetHotel / nights) * 0.80,
        maxHotelStarRating: 3.5,
        preferredCabinClass: "economy",
      };
    }

    return {
      maxFlightPricePerPerson: targetFlight * 0.75,
      maxHotelPricePerNight: (targetHotel / nights) * 0.65,
      maxHotelStarRating: 3.0,
      maxActivityCostPerDay: (targetActivity / days) * 0.55,
      allowTrainFallback: true,
    };
  }

  static generateSuggestions(over: number, flight: number, hotel: number, activity: number, roundNum: number): string[] {
    const s: string[] = [];
    if (roundNum === 0) {
      s.push(`控制每日活动预算，优先选择免费景点`);
      s.push("选择更实惠的餐饮方案");
    } else if (roundNum === 1) {
      s.push(`降低酒店等级至 3.5 星以下`);
      s.push("搜索距离市中心稍远但性价比更高的酒店");
    } else {
      s.push("搜索经济舱低价航班，考虑高铁/动车替代方案");
      s.push("降低酒店至 3 星标准");
    }
    return s;
  }
}
