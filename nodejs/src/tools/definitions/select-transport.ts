import type { RegisteredTool } from "../types.js";

export function createSelectTransportTool(): RegisteredTool {
  return {
    name: "select_transport",
    description: "用户选择去程和返程交通。LLM 调用此工具传递用户确认的交通选项。",
    input_schema: {
      type: "object",
      properties: {
        outboundId: { type: "string", description: "去程选项 id (航班号/车次)" },
        returnId:   { type: "string", description: "返程选项 id (航班号/车次)" },
      },
      required: ["outboundId", "returnId"],
    },
    metadata: { category: "planning", timeout: 5_000 },
    execute: async (input) => {
      return {
        success: true,
        data: {
          outboundId: input.outboundId,
          returnId: input.returnId,
        },
      };
    },
  };
}
