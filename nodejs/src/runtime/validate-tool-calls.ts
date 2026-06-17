import type { ZodType } from "zod";
import type { AgentState } from "./state.js";
import { isToolAllowedInPhase, listToolsForPhase } from "../tools/policy.js";

export interface ToolCall {
  id?: string;
  name: string;
  input: Record<string, unknown>;
}

export type ValidationCode =
  | "PHASE_NOT_ALLOWED"
  | "SCHEMA_INVALID"
  | "DUPLICATE_CALL"
  | "PRECONDITION_MISSING"
  | "QPS_THROTTLED";

export interface RejectedCall {
  call: ToolCall;
  code: ValidationCode;
  reason: string;
}

export interface ValidationResult {
  approved: ToolCall[];
  rejected: RejectedCall[];
}

export type SchemaLookup = (name: string) => ZodType | undefined;

export interface PreconditionEntry {
  check: (call: ToolCall, state: AgentState) => boolean;
  desc: string;
}

export const PRECONDITIONS: Record<string, PreconditionEntry> = {
  select_transport: {
    check: (_c, s) => (s.candidateTransports?.length ?? 0) > 0,
    desc: "candidateTransports 不为空",
  },
  select_hotel: {
    check: (_c, s) => (s.candidateHotels?.length ?? 0) > 0,
    desc: "candidateHotels 不为空",
  },
  finalize_plan: {
    check: (_c, s) => Boolean(s.selectedOutbound && s.selectedReturn && s.selectedHotel),
    desc: "selectedOutbound + selectedReturn + selectedHotel 都已选",
  },
  search_restaurants: {
    check: (c, s) =>
      c.input.scope !== "attraction" || (s.candidateAttractions?.length ?? 0) > 0,
    desc: "scope=attraction 时 candidateAttractions 不为空",
  },
};

export function stableHash(obj: unknown): string {
  return JSON.stringify(obj, (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.keys(value as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (value as Record<string, unknown>)[k];
          return acc;
        }, {});
    }
    return value;
  });
}

export function validateToolCalls(
  calls: ToolCall[],
  state: AgentState,
  schemaLookup: SchemaLookup,
): ValidationResult {
  const approved: ToolCall[] = [];
  const rejected: RejectedCall[] = [];
  const seen = new Set<string>();

  for (const rawCall of calls) {
    let call = rawCall;

    if (!isToolAllowedInPhase(call.name, state.phase)) {
      const allowedNames = listToolsForPhase(state.phase).map(t => t.name).join(", ");
      rejected.push({
        call,
        code: "PHASE_NOT_ALLOWED",
        reason: `${call.name} 在 ${state.phase} 阶段不可用。可用工具:${allowedNames || "(无)"}`,
      });
      continue;
    }

    const schema = schemaLookup(call.name);
    if (schema) {
      const parsed = schema.safeParse(call.input);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map(i => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        rejected.push({
          call,
          code: "SCHEMA_INVALID",
          reason: `参数校验失败:${issues}`,
        });
        continue;
      }
      call = { ...call, input: parsed.data as Record<string, unknown> };
    }

    const dedupKey = `${call.name}:${stableHash(call.input)}`;
    if (seen.has(dedupKey)) {
      rejected.push({
        call,
        code: "DUPLICATE_CALL",
        reason: `本轮已调用过 ${call.name}(相同参数),请勿重复。`,
      });
      continue;
    }
    seen.add(dedupKey);

    const precond = PRECONDITIONS[call.name];
    if (precond && !precond.check(call, state)) {
      rejected.push({
        call,
        code: "PRECONDITION_MISSING",
        reason: `${call.name} 要求前置条件不满足:${precond.desc}`,
      });
      continue;
    }

    approved.push(call);
  }

  return { approved, rejected };
}
