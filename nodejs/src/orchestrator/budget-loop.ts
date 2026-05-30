import type { Logger } from "pino";
import { PlanningState, type TravelPlanState } from "../types/index.js";
import type { BudgetAgent } from "../agents/budget-agent.js";
import type { ParallelExecutor } from "./parallel.js";
import { settings } from "../config/settings.js";

export class BudgetLoopController {
  private readonly maxRetries: number;

  constructor(
    private readonly parallelExecutor: ParallelExecutor,
    private readonly budgetAgent: BudgetAgent,
    private readonly log: Logger,
    maxRetries?: number,
  ) {
    this.maxRetries = maxRetries ?? settings.BUDGET_MAX_RETRIES;
  }

  async run(state: TravelPlanState): Promise<TravelPlanState> {
    state.maxAdjustments = this.maxRetries;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const label = attempt === 0 ? "初始搜索" : `第 ${attempt} 轮调整`;
      this.log.info({ attempt, label }, "预算循环迭代");

      if (attempt === 0 || state.state === PlanningState.ADJUSTING) {
        state = await this.parallelExecutor.run(state);
      }

      state.state = PlanningState.BUDGET_CHECKING;
      state = await this.budgetAgent.run(state);

      if (state.state === PlanningState.COMPLETED || state.state === PlanningState.FAILED) {
        return state;
      }
    }

    this.log.warn("达到最大调整轮次");
    state.state = PlanningState.COMPLETED;
    return state;
  }
}
