import type { RegisteredTool } from "../types.js";

export function createCollectPreferencesTool(): RegisteredTool {
  return {
    name: "collect_preferences",
    description:
      "当用户表达旅行意图时调用此工具。系统会弹出偏好表单让用户确认或补充信息。必须从用户消息中提取所有已知信息传入。",
    input_schema: {
      type: "object",
      properties: {
        destination: {
          type: "string",
          description: "从用户消息中识别出的目的地城市名称",
        },
        message_to_user: {
          type: "string",
          description: "发给用户的确认消息，如'好的，让我帮您规划去北京的旅行'",
        },
        departure_city: {
          type: "string",
          description: "从用户消息中识别出的出发城市，未提及则为空",
        },
        start_date: {
          type: "string",
          description: "出发日期 YYYY-MM-DD，从用户消息中提取，未提及则为空",
        },
        end_date: {
          type: "string",
          description: "返回日期 YYYY-MM-DD，从用户消息中提取，未提及则为空",
        },
        budget: {
          type: "number",
          description: "总预算（元），从用户消息中提取，未提及则为0",
        },
        num_travelers: {
          type: "number",
          description: "出行人数，从用户消息中提取，未提及则为0",
        },
      },
      required: ["destination", "message_to_user"],
    },
    metadata: { requiresUserInput: true, sseHint: "needs_input", category: "preference" },
    execute: async (input) => {
      return {
        success: true,
        data: {
          status: "awaiting_input",
          destination: input.destination,
          message: input.message_to_user,
          departure_city: input.departure_city ?? "",
          start_date: input.start_date ?? "",
          end_date: input.end_date ?? "",
          budget: Number(input.budget) || 0,
          num_travelers: Number(input.num_travelers) || 0,
        },
      };
    },
  };
}
