/** @deprecated 被 Agent Loop 的 finalize_plan 取代。P0-C §3 删除旧 Pipeline 后此工具仅返回 deprecated 提示,不再执行实际规划。保留工具定义是为了 ToolRegistry 不出现悬挂引用。 */
import type { RegisteredTool } from "../types.js";

export function createPlanTravelTool(): RegisteredTool {
  return {
    name: "plan_travel",
    description: "[DEPRECATED] 旧 Pipeline 行程规划入口。已被 Agent Loop 的 finalize_plan 取代。",
    input_schema: {
      type: "object",
      properties: {
        destination: { type: "string" },
        departure_city: { type: "string" },
        start_date: { type: "string" },
        end_date: { type: "string" },
        budget: { type: "number" },
      },
      required: ["destination", "departure_city", "start_date", "end_date", "budget"],
    },
    metadata: { category: "planning", timeout: 5_000 },
    execute: async () => ({
      success: false,
      data: null,
      error: "plan_travel is deprecated. Use Agent Loop with finalize_plan tool instead.",
    }),
  };
}
