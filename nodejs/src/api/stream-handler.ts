import type { FastifyRequest, FastifyReply } from "fastify";
import { streamChat, type Message, type ContentBlock } from "./llm-client.js";
import { registry } from "./tools.js";
import type { ConversationOrchestrator } from "../orchestrator/conversation-orchestrator.js";
import * as chatSystemPrompt from "../prompts/chat-system.js";

function buildSystemPrompt(): string {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  return chatSystemPrompt.build({ date: `${yyyy}-${mm}-${dd}` });
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
  const toolDefs = registry.getToolDefs();

  for (let round = 0; round < maxRounds; round++) {
    const { events, assistantContent } = await streamChat(
      messages,
      toolDefs,
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

      const toolMeta = registry.get(toolEvent.name)?.metadata;

      if (toolMeta?.requiresUserInput) {
        const result = await registry.execute(toolEvent.name, toolEvent.input);
        if (result.success) {
          const d = result.data as Record<string, unknown>;
          writeSSE(reply, "needs_input", {
            tool_use_id: toolEvent.id,
            destination: String(d.destination ?? ""),
            departure_city: String(d.departure_city ?? ""),
            start_date: String(d.start_date ?? ""),
            end_date: String(d.end_date ?? ""),
            budget: Number(d.budget) || 0,
            num_travelers: Number(d.num_travelers) || 0,
          });
        }
        return;
      }

      const result = await registry.execute(toolEvent.name, toolEvent.input);
      const resultPayload = result.success ? result.data : { error: result.error };

      if (result.sources && result.sources.length > 0) {
        writeSSE(reply, "reference_sources", { sources: result.sources });
      }

      writeSSE(reply, "tool_result", { tool: toolEvent.name, result: resultPayload });

      const toolResultBlock: ContentBlock = {
        type: "tool_result",
        tool_use_id: toolEvent.id,
        content: JSON.stringify(resultPayload),
      };
      messages.push({ role: "user", content: [toolResultBlock] });
    }
  }
}

interface ConversationMessageBody {
  message: string;
}

interface SelectBody {
  type: "transport" | "hotel";
  action?: "confirm" | "rescan";
  outboundId?: string;
  returnId?: string;
  hotelId?: string;
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

export async function handleSelectMessage(
  req: FastifyRequest<{ Params: { sid: string }; Body: SelectBody }>,
  reply: FastifyReply,
  orchestrator: ConversationOrchestrator,
): Promise<void> {
  const { sid } = req.params;
  const body = req.body;

  if (!body?.type) {
    return reply.status(400).send({ error: "type is required (transport|hotel)" });
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
    await orchestrator.handleSelect(sid, body, emit);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit("error", { error: msg, recoverable: false });
  }

  reply.raw.write("event: done\ndata: {}\n\n");
  reply.raw.end();
}
