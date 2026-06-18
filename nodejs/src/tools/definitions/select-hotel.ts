import type { RegisteredTool } from "../types.js";

export function createSelectHotelTool(): RegisteredTool {
  return {
    name: "select_hotel",
    description: "用户选择酒店。LLM 调用此工具传递用户确认的酒店选项。",
    input_schema: {
      type: "object",
      properties: {
        hotelId: { type: "string", description: "酒店 id (名称或序号)" },
      },
      required: ["hotelId"],
    },
    metadata: { category: "planning", timeout: 5_000 },
    execute: async (input) => {
      return {
        success: true,
        data: {
          hotelId: input.hotelId,
        },
      };
    },
  };
}
