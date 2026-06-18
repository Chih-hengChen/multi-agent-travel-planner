import type { SSEEvent, SSEEmitter } from "./agent-loop.js";

export interface ForwardingSSEEmitter extends SSEEmitter {
  emit(event: SSEEvent): void;
}

export function createSSEBridge(
  emitFn: (event: string, data: unknown) => void,
): ForwardingSSEEmitter {
  return {
    emit(event: SSEEvent) {
      switch (event.type) {
        case "llm_request":
          emitFn("progress", {
            phase: event.phase,
            iteration: event.iter,
            tool: event.tools?.join(", "),
            status: "running",
            message: `LLM 决策中...`,
          });
          break;

        case "llm_response":
          emitFn("progress", {
            phase: "",
            iteration: event.iter,
            tool: "",
            status: "done",
            message: event.thought
              ? `推理:${(event.thought as string).slice(0, 100)}`
              : `调用 ${(event.toolCallCount as number) ?? 0} 个工具`,
          });
          break;

        case "tools_executed":
          emitFn("progress", {
            phase: "",
            iteration: event.iter,
            tool: "",
            status: "done",
            message: `执行 ${event.count} 个工具${event.failures ? `(${event.failures} 失败)` : ""}`,
          });
          break;

        case "phase_change":
          emitFn("state_change", { state: event.phase });
          break;

        default:
          emitFn("progress", {
            phase: "",
            iteration: event.iter,
            tool: "",
            status: "running",
            message: event.type,
          });
      }
    },
  };
}
