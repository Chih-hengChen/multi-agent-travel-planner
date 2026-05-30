import type { FastifyRequest, FastifyReply } from "fastify";
import { streamChat, type Message, type ContentBlock } from "./llm-client.js";
import { TOOLS, executeTool } from "./tools.js";

const SYSTEM_PROMPT = `你是一个专业的旅行规划助手。与用户自然对话，了解旅行需求。

规则：
- 友好简洁，每次回复 2-3 句话
- 当收集到目的地、出发城市、出发/返回日期和预算后，调用 plan_travel 工具生成行程
- 收到工具返回的行程后，用生动的语言向用户介绍行程亮点
- 不要编造工具返回以外的信息
- 用中文回复`;

interface ChatStreamBody {
  message: string;
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

  const messages: Message[] = [
    ...clientMessages,
    { role: "user", content: message },
  ];

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

    const toolUseEvents = events.filter((e) => e.type === "tool_use");
    if (toolUseEvents.length === 0) break;

    for (const toolEvent of toolUseEvents) {
      if (toolEvent.type !== "tool_use") continue;

      writeSSE(reply, "tool_start", {
        tool: toolEvent.name,
        input: toolEvent.input,
      });

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
