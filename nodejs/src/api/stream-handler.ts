import type { FastifyRequest, FastifyReply } from "fastify";
import type { ConversationOrchestrator } from "../orchestrator/conversation-orchestrator.js";

function writeSSE(reply: FastifyReply, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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
