import type { Logger } from "pino";
import type { TravelPlanState } from "../types/index.js";
import type { BaseAgent } from "../agents/base-agent.js";
import { settings } from "../config/settings.js";

export class ParallelExecutor {
  private readonly timeout: number;

  constructor(
    private readonly agents: BaseAgent[],
    private readonly log: Logger,
    timeout?: number,
  ) {
    this.timeout = timeout ?? settings.PARALLEL_TIMEOUT;
  }

  async run(state: TravelPlanState): Promise<TravelPlanState> {
    this.log.info({ agents: this.agents.length }, "并行执行开始");

    const tasks = this.agents.map((agent) => {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`${agent.name} timed out after ${this.timeout}s`)), this.timeout * 1000),
      );
      return Promise.race([agent.run(state), timeoutPromise]).catch((err: Error) => err);
    });

    const results = await Promise.allSettled(tasks);

    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      if (result.status === "rejected") {
        const errMsg = `${this.agents[i]!.name} 并行执行失败: ${result.reason}`;
        this.log.error({ agent: this.agents[i]!.name }, errMsg);
        state.errorMessages.push(errMsg);
      }
    }

    this.log.info("并行执行完成");
    return state;
  }
}
