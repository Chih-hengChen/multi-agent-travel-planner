import type { Logger } from "pino";
import type { TravelPlanState } from "../types/index.js";
import type { BaseAgent } from "../agents/base-agent.js";

export interface AgentRunResult {
  agentName: string;
  success: boolean;
  timedOut: boolean;
  retried: boolean;
  degraded: boolean;
  error?: string;
}

async function runWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} 超时 ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ParallelExecutor {
  constructor(
    private readonly agents: BaseAgent[],
    private readonly log: Logger,
    private readonly defaultTimeoutMs = 120_000,
    private readonly defaultMaxRetries = 1,
  ) {}

  async runSequential(state: TravelPlanState): Promise<{ state: TravelPlanState; results: AgentRunResult[] }> {
    this.log.info({ agents: this.agents.length }, "顺序执行开始");

    const results: AgentRunResult[] = [];

    for (const agent of this.agents) {
      const result = await this.runSingle(agent, state);
      results.push(result);
      if (result.error) {
        state.errorMessages.push(`${agent.name}: ${result.error}`);
      }
    }

    const failed = results.filter((r) => !r.success);
    if (failed.length > 0) {
      this.log.warn({ failed: failed.map((r) => r.agentName) }, "部分 Agent 执行失败");
    }

    this.log.info("顺序执行完成");
    return { state, results };
  }

  async runParallel(state: TravelPlanState): Promise<{ state: TravelPlanState; results: AgentRunResult[] }> {
    this.log.info({ agents: this.agents.length }, "真正并行执行");

    const settled = await Promise.allSettled(
      this.agents.map((agent) => this.runSingle(agent, state)),
    );

    const results: AgentRunResult[] = [];
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i];
      if (s.status === "fulfilled") {
        results.push(s.value);
        if (s.value.error) {
          state.errorMessages.push(`${this.agents[i].name}: ${s.value.error}`);
        }
      } else {
        const err = s.reason instanceof Error ? s.reason.message : String(s.reason);
        results.push({
          agentName: this.agents[i].name,
          success: false,
          timedOut: true,
          retried: false,
          degraded: false,
          error: err,
        });
        state.errorMessages.push(`${this.agents[i].name}: ${err}`);
      }
    }

    const failed = results.filter((r) => !r.success);
    if (failed.length > 0) {
      this.log.warn({ failed: failed.map((r) => r.agentName) }, "部分 Agent 并行执行失败");
    }

    this.log.info("并行执行完成");
    return { state, results };
  }

  /** @deprecated Use runSequential or runParallel instead */
  async run(state: TravelPlanState): Promise<{ state: TravelPlanState; results: AgentRunResult[] }> {
    return this.runSequential(state);
  }

  private async runSingle(agent: BaseAgent, state: TravelPlanState): Promise<AgentRunResult> {
    const baseResult: AgentRunResult = {
      agentName: agent.name,
      success: false,
      timedOut: false,
      retried: false,
      degraded: false,
    };

    // Attempt 1: normal execution
    const first = await this.tryRun(agent, state, this.defaultTimeoutMs);
    if (first.success) return first;

    // Attempt 2: retry with longer timeout
    if (first.timedOut && this.defaultMaxRetries > 0) {
      this.log.warn({ agent: agent.name }, "首次超时，尝试重试（1.5x 超时）");
      const retry = await this.tryRun(agent, state, this.defaultTimeoutMs * 1.5);
      retry.retried = true;
      if (retry.success) return retry;
      baseResult.error = retry.error;
    } else {
      baseResult.error = first.error;
    }

    // Degrade — let pipeline continue with partial data
    baseResult.timedOut = true;
    baseResult.degraded = true;
    baseResult.success = true;

    this.log.warn({ agent: agent.name, error: baseResult.error }, "Agent 降级执行");

    return baseResult;
  }

  private async tryRun(
    agent: BaseAgent,
    state: TravelPlanState,
    timeoutMs: number,
  ): Promise<AgentRunResult> {
    try {
      await runWithTimeout(() => agent.run(state), timeoutMs, agent.name);
      return { agentName: agent.name, success: true, timedOut: false, retried: false, degraded: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTimeout = msg.includes("超时") || msg.includes("timed out");
      this.log.warn({ agent: agent.name, error: msg, timeout: isTimeout }, "Agent 执行失败");
      return {
        agentName: agent.name,
        success: false,
        timedOut: isTimeout,
        retried: false,
        degraded: false,
        error: msg,
      };
    }
  }
}
