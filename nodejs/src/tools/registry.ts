import type { ToolDef } from "../api/llm-client.js";
import type { RegisteredTool, ToolResult } from "./types.js";

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  getToolDefs(): ToolDef[] {
    return Array.from(this.tools.values()).map(({ name, description, input_schema }) => ({
      name,
      description,
      input_schema,
    }));
  }

  async execute(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { success: false, data: null, error: `Unknown tool: ${name}` };
    }

    const timeout = tool.metadata?.timeout ?? 30_000;
    try {
      const result = await Promise.race([
        tool.execute(input),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Tool ${name} timed out after ${timeout}ms`)), timeout),
        ),
      ]);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, data: null, error: msg };
    }
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): string[] {
    return Array.from(this.tools.keys());
  }
}
