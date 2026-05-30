import pino, { type Logger } from "pino";
import { TravelStyle, TravelPlanState, PlanningState, type UserPreferences } from "../types/index.js";
import { PreferenceAgent, DestinationAgent, FlightAgent, HotelAgent, ActivityAgent, BudgetAgent } from "../agents/index.js";
import { ParallelExecutor } from "./parallel.js";
import { BudgetLoopController } from "./budget-loop.js";

export class TravelPlanningPipeline {
  private readonly prefAgent: PreferenceAgent;
  private readonly destAgent: DestinationAgent;
  private readonly budgetLoop: BudgetLoopController;

  constructor(log?: Logger) {
    const logger: Logger = log ?? pino({ level: "info" });
    const flightAgent = new FlightAgent(logger);
    const hotelAgent = new HotelAgent(logger);
    const activityAgent = new ActivityAgent(logger);
    const budgetAgent = new BudgetAgent(logger);

    this.prefAgent = new PreferenceAgent(logger);
    this.destAgent = new DestinationAgent(logger);

    const parallel = new ParallelExecutor([flightAgent, hotelAgent, activityAgent], logger);
    this.budgetLoop = new BudgetLoopController(parallel, budgetAgent, logger);
  }

  async run(preferences: UserPreferences): Promise<TravelPlanState> {
    const state = new TravelPlanState();
    state.preferences = preferences;

    state.state = PlanningState.COLLECTING_PREFERENCES;
    let result = await this.prefAgent.run(state);
    if (result.state === PlanningState.FAILED) return result;

    result = await this.destAgent.run(result);
    if (result.state === PlanningState.FAILED) return result;

    result = await this.budgetLoop.run(result);
    return result;
  }
}

export async function quickPlan(opts: {
  budget?: number;
  departure?: string;
  start?: string;
  end?: string;
  style?: string;
  travelers?: number;
} = {}): Promise<TravelPlanState> {
  const prefs: UserPreferences = {
    budget: opts.budget ?? 10000,
    travelStyle: (opts.style as TravelStyle) ?? TravelStyle.COMFORT,
    departureCity: opts.departure ?? "北京",
    startDate: opts.start ?? "2026-05-01",
    endDate: opts.end ?? "2026-05-05",
    numTravelers: opts.travelers ?? 1,
    interests: [],
    dietaryRestrictions: [],
    accessibilityNeeds: [],
    notes: "",
  };
  const pipeline = new TravelPlanningPipeline();
  return pipeline.run(prefs);
}
