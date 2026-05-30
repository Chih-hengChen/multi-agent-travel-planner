import { settings } from "../config/settings.js";

export interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "message_stop" };

export interface ChatResult {
  events: StreamEvent[];
  assistantContent: ContentBlock[];
}

export async function streamChat(
  messages: Message[],
  tools?: ToolDef[],
  system?: string,
  onDelta?: (text: string) => void,
): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model: settings.LLM_MODEL,
    messages,
    temperature: settings.LLM_TEMPERATURE,
    max_tokens: settings.LLM_MAX_TOKENS,
    stream: true,
  };
  if (system) body.system = system;
  if (tools?.length) body.tools = tools;

  const resp = await fetch(`${settings.LLM_BASE_URL}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": settings.LLM_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`LLM API ${resp.status}: ${err}`);
  }

  return parseStream(resp, onDelta);
}

async function parseStream(
  resp: Response,
  onDelta?: (text: string) => void,
): Promise<ChatResult> {
  const events: StreamEvent[] = [];
  const contentBlocks: ContentBlock[] = [];
  const toolInputBuffers = new Map<number, string>();
  let currentBlockIndex = -1;

  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (raw === "[DONE]" || !raw) continue;

      let evt: Record<string, unknown>;
      try { evt = JSON.parse(raw); } catch { continue; }

      const type = evt.type as string;

      if (type === "content_block_start") {
        const block = evt.content_block as Record<string, unknown>;
        currentBlockIndex = evt.index as number;
        if (block?.type === "tool_use") {
          toolInputBuffers.set(currentBlockIndex, "");
          contentBlocks.push({
            type: "tool_use",
            id: block.id as string,
            name: block.name as string,
            input: {},
          });
        }
      } else if (type === "content_block_delta") {
        const delta = evt.delta as Record<string, unknown>;
        const idx = (evt.index as number) ?? currentBlockIndex;
        if (delta?.type === "text_delta") {
          const text = delta.text as string;
          events.push({ type: "text_delta", text });
          onDelta?.(text);
          const existing = contentBlocks[idx];
          if (existing?.type === "text") {
            existing.text += text;
          } else if (!existing) {
            contentBlocks[idx] = { type: "text", text };
          }
        } else if (delta?.type === "input_json_delta") {
          const prev = toolInputBuffers.get(idx) ?? "";
          toolInputBuffers.set(idx, prev + (delta.partial_json as string));
        }
      } else if (type === "content_block_stop") {
        const idx = (evt.index as number) ?? currentBlockIndex;
        const buf = toolInputBuffers.get(idx);
        if (buf != null) {
          try {
            const parsed = JSON.parse(buf);
            const block = contentBlocks.find(
              (b) => b.type === "tool_use" && b.id === (contentBlocks[idx] as { id: string })?.id,
            );
            if (block && block.type === "tool_use") block.input = parsed;
            const toolId = block?.type === "tool_use" ? block.id : "";
            const toolName = block?.type === "tool_use" ? block.name : "";
            events.push({ type: "tool_use", id: toolId, name: toolName, input: parsed });
          } catch { /* ignore parse errors */ }
          toolInputBuffers.delete(idx);
        }
      } else if (type === "message_stop") {
        events.push({ type: "message_stop" });
      }
    }
  }

  return { events, assistantContent: contentBlocks };
}
