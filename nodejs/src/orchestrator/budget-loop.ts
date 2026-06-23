import type { Logger } from "pino";
import { PlanningState, type TravelPlanState, type ProgressCallback } from "../types/index.js";
import type { BudgetAgent } from "../agents/budget-agent.js";
import type { PipelineExecutor, AgentRunResult } from "./parallel.js";
import { sessionLogger } from "../logging/session-logger.js";
import { settings } from "../config/settings.js";

export class BudgetLoopController {
  private readonly maxRetries: number;

  constructor(
    private readonly flightHotelExecutor: PipelineExecutor,
    private readonly planExecutor: PipelineExecutor,
    private readonly budgetAgent: BudgetAgent,
    private readonly log: Logger,
    maxRetries?: number,
  ) {
    this.maxRetries = maxRetries ?? settings.BUDGET_MAX_RETRIES;
  }

  async run(state: TravelPlanState, onProgress?: ProgressCallback): Promise<TravelPlanState> {
    state.maxAdjustments = this.maxRetries;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const label = attempt === 0 ? "初始搜索" : `第 ${attempt} 轮调整`;
      this.log.info({ attempt, label }, "预算循环迭代");

      if (attempt === 0 || state.state === PlanningState.ADJUSTING) {
        if (onProgress) {
          onProgress({ phase: "搜索交通和酒店", status: "running", progressPercent: 0, estimatedSecondsLeft: 120, round: attempt + 1, maxRounds: this.maxRetries + 1 });
        }
        const { state: searchState, results: searchResults } = await this.flightHotelExecutor.runParallel(state, onProgress);
        state = searchState;

        if (onProgress) {
          onProgress({ phase: "生成行程计划", status: "running", progressPercent: 0, estimatedSecondsLeft: 60, round: attempt + 1, maxRounds: this.maxRetries + 1 });
        }
        const { state: planState, results: planResults } = await this.planExecutor.runSequential(state, onProgress);
        state = planState;

        const results = [...searchResults, ...planResults];

        this.handleAgentFailures(state, results, attempt);

        const unrecoverable = results.some(
          (r) => !r.success && !r.degraded && r.agentName !== "activityAgent",
        );
        if (unrecoverable) {
          this.log.error("核心 Agent 不可恢复失败");
          state.state = PlanningState.FAILED;
          return state;
        }
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

  private handleAgentFailures(
    state: TravelPlanState,
    results: AgentRunResult[],
    attempt: number,
  ): void {
    const degraded = results.filter((r) => r.degraded);
    const hardFailed = results.filter((r) => !r.success && !r.degraded);

    for (const r of degraded) {
      this.log.warn({ agent: r.agentName }, "Agent 降级运行");
      sessionLogger.append("pipeline", "recovery_action", {
        agent: r.agentName,
        action: "degraded",
        error: r.error,
        attempt,
      });
    }

    for (const r of hardFailed) {
      this.log.error({ agent: r.agentName, error: r.error }, "Agent 不可恢复");
      sessionLogger.append("pipeline", "recovery_action", {
        agent: r.agentName,
        action: "terminal",
        error: r.error,
        attempt,
      });
    }
  }
}
