import type { FastifyRequest, FastifyReply } from "fastify";
import { streamChat, type Message, type ContentBlock } from "./llm-client.js";
import { TOOLS, executeTool } from "./tools.js";
import type { ConversationOrchestrator } from "../orchestrator/conversation-orchestrator.js";

function buildSystemPrompt(): string {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  return `你是一个专业的旅行规划助手。当前日期：${yyyy}-${mm}-${dd}。

规则：
- 友好简洁，每次回复 2-3 句话
- 当用户表达旅行意图时（如"我想去XX旅游"），立即调用 collect_preferences 工具
- 调用 collect_preferences 时，必须从用户消息中提取所有已知信息填入参数（destination、departure_city、start_date、end_date、budget、num_travelers），用户未提及的字段留空
- 日期格式为 YYYY-MM-DD，年份默认为 ${yyyy} 年
- 收到偏好数据后，调用 plan_travel 工具生成行程方案
- 调用 plan_travel 时，必须将用户提供的所有偏好参数原样传入，特别是 transport_preference（交通偏好）、departure_time、interests 等，不要遗漏
- 收到行程结果后，用生动的语言向用户介绍行程亮点
- 不要编造工具返回以外的信息
- 用中文回复`;
}

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
      buildSystemPrompt(),
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
        const r = await executeTool(toolEvent.name, toolEvent.input) as Record<string, unknown>;
        writeSSE(reply, "needs_input", {
          tool_use_id: toolEvent.id,
          destination: String(r.destination ?? ""),
          departure_city: String(r.departure_city ?? ""),
          start_date: String(r.start_date ?? ""),
          end_date: String(r.end_date ?? ""),
          budget: Number(r.budget) || 0,
          num_travelers: Number(r.num_travelers) || 0,
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

interface ConversationMessageBody {
  message: string;
}

export async function handleConversationMessage(
  req: FastifyRequest<{ Params: { sid: string }; Body: ConversationMessageBody }>,
  reply: FastifyReply,
  orchestrator: ConversationOrchestrator,
): Promise<void> {
  const { sid } = req.params;
  const { message } = req.body;

  if (!message?.trim()) {
    return reply.status(400).send({ error: "message is required" });
  }

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const emit = (event: string, data: unknown) => {
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    await orchestrator.handleMessage(sid, message, emit);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit("error", { error: msg, recoverable: false });
  }

  reply.raw.write("event: done\ndata: {}\n\n");
  reply.raw.end();
}
