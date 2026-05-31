import type { FastifyRequest, FastifyReply } from "fastify";
import { streamChat, type Message, type ContentBlock } from "./llm-client.js";
import { TOOLS, executeTool } from "./tools.js";

const SYSTEM_PROMPT = `你是一个专业的旅行规划助手。

规则：
- 友好简洁，每次回复 2-3 句话
- 当用户表达旅行意图时（如"我想去XX旅游"），立即调用 collect_preferences 工具
- collect_preferences 会触发偏好收集表单，系统返回完整偏好数据
- 收到偏好数据后，调用 plan_travel 工具生成行程方案
- 收到行程结果后，用生动的语言向用户介绍行程亮点
- 不要编造工具返回以外的信息
- 用中文回复`;

interface ChatStreamBody {
  message?: string;
  messages?: Message[];
}

function writeSSE(reply: FastifyReply, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function handleChatStream(
  req: FastifyRequest<{ Body: ChatStreamBody }>,
  reply: FastifyReply,
): Promise<void> {
  const { message, messages: clientMessages = [] } = req.body;

  const messages: Message[] = [...clientMessages];
  if (message) {
    messages.push({ role: "user", content: message });
  }

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  try {
    await runAgentLoop(messages, reply);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeSSE(reply, "error", { error: msg });
  }

  reply.raw.write("event: done\ndata: {}\n\n");
  reply.raw.end();
}

async function runAgentLoop(
  messages: Message[],
  reply: FastifyReply,
): Promise<void> {
  const maxRounds = 5;

  for (let round = 0; round < maxRounds; round++) {
    const { events, assistantContent } = await streamChat(
      messages,
      TOOLS,
      SYSTEM_PROMPT,
      (text) => writeSSE(reply, "text_delta", { text }),
    );

    messages.push({ role: "assistant", content: assistantContent });
    writeSSE(reply, "assistant_message", { content: assistantContent });

    const toolUseEvents = events.filter((e) => e.type === "tool_use");
    if (toolUseEvents.length === 0) break;

    for (const toolEvent of toolUseEvents) {
      if (toolEvent.type !== "tool_use") continue;

      writeSSE(reply, "tool_start", {
        tool: toolEvent.name,
        input: toolEvent.input,
      });

      if (toolEvent.name === "collect_preferences") {
        writeSSE(reply, "needs_input", {
          tool_use_id: toolEvent.id,
          destination: toolEvent.input.destination ?? "",
        });
        return;
      }

      const result = await executeTool(toolEvent.name, toolEvent.input);

      writeSSE(reply, "tool_result", { tool: toolEvent.name, result });

      const toolResultBlock: ContentBlock = {
        type: "tool_result",
        tool_use_id: toolEvent.id,
        content: JSON.stringify(result),
      };
      messages.push({ role: "user", content: [toolResultBlock] });
    }
  }
}
