import type { ToolDef } from "../api/llm-client.js";

export interface ToolSource {
  title: string;
  url: string;
  type: "xhs" | "web" | "train" | "hotel" | "flight" | "attraction";
}

export interface ToolResult {
  success: boolean;
  data: unknown;
  sources?: ToolSource[];
  error?: string;
}

export type RiskLevel = "safe_auto" | "confirm_required" | "sensitive" | "disabled";
export type CostLevel = "free" | "paid" | "unknown";

export interface ToolMetadata {
  requiresUserInput?: boolean;
  sseHint?: string;
  timeout?: number;
  category?: "search" | "planning" | "preference";
  riskLevel?: RiskLevel;
  costLevel?: CostLevel;
  maxRetries?: number;
  requiresNetwork?: boolean;
  outputValidator?: string;
}

export interface RegisteredTool extends ToolDef {
  execute: (input: Record<string, unknown>) => Promise<ToolResult>;
  metadata?: ToolMetadata;
}
