import { settings } from "../config/settings.js";
import type { LlmSelfEval, PlanSummary, TraceSummary } from "./feedback-store.js";
import { saveLlmSelfEval } from "./feedback-store.js";

const SELF_EVAL_PROMPT = `你是一个旅行规划质量评估助手。请根据以下行程和上下文，对这次规划进行打分。

评分维度（各 1-5 分）：
1. 完整性(completeness)：行程天数是否完整覆盖，每日活动是否充实，交通和住宿是否齐全
2. 多样性(diversity)：景点类型是否多样（历史文化/自然风光/美食/购物/娱乐），餐厅选择是否丰富
3. 预算合理性(budgetReasonableness)：总花费是否在预算内，单项花费是否合理
4. 可执行性(executability)：景点之间距离是否合理，开放时间是否匹配，交通衔接是否可行
5. 创意性(creativity)：是否有特色体验或小众推荐，是否超出模板化规划

如果行程有明显缺陷，请在 failureCategory 中标注：
- incomplete_plan：行程不完整
- bad_restaurant：餐厅选择差
- budget_blow：预算超支严重
- transit_gap：交通衔接缺失
- low_diversity：景点类型单一
- other：其他问题

用户需求：{userMessage}

行程摘要：
- 目的地：{destination}
- 出发城市：{departureCity}
- 天数：{days}
- 人数：{numTravelers}
- 预算：{budget}
- 实际总花费：{totalCost}
- 预算内：{withinBudget}
- 酒店：{hotelName}
- 交通方式：{transportMode}

执行摘要：
- 总迭代次数：{totalIters}
- 工具调用次数：{toolCallCount}
- 降级次数：{fallbackCount}
- 错误数：{errorCount}

请返回纯 JSON（不要其他文字）：
{
  "scores": {
    "completeness": 4,
    "diversity": 3,
    "budgetReasonableness": 4,
    "executability": 5,
    "creativity": 3
  },
  "failureCategory": "low_diversity",
  "notes": "简要说明扣分原因和改进建议"
}`;

export function buildSelfEvalPrompt(
  userMessage: string,
  plan: PlanSummary,
  trace: TraceSummary,
): string {
  return SELF_EVAL_PROMPT
    .replace("{userMessage}", userMessage)
    .replace("{destination}", plan.destination)
    .replace("{departureCity}", plan.departureCity)
    .replace("{days}", String(plan.days))
    .replace("{numTravelers}", String(plan.numTravelers))
    .replace("{budget}", String(plan.budget))
    .replace("{totalCost}", String(plan.totalCost))
    .replace("{withinBudget}", String(plan.withinBudget))
    .replace("{hotelName}", plan.hotelName ?? "未知")
    .replace("{transportMode}", plan.transportMode ?? "未知")
    .replace("{totalIters}", String(trace.totalIters))
    .replace("{toolCallCount}", String(trace.toolCallCount))
    .replace("{fallbackCount}", String(trace.fallbackCount))
    .replace("{errorCount}", String(trace.errorCount));
}

export async function runSelfEval(
  sid: string,
  userMessage: string,
  plan: PlanSummary,
  trace: TraceSummary,
  sessionLogger?: { append: (sid: string, event: string, data: unknown) => void },
): Promise<void> {
  const prompt = buildSelfEvalPrompt(userMessage, plan, trace);

  try {
    let raw: string;
    if (settings.LLM_PROVIDER === "anthropic") {
      const resp = await fetch(`${settings.LLM_BASE_URL}/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": settings.LLM_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: settings.LLM_LIGHT_MODEL,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.2,
          max_tokens: 1024,
          thinking: { type: "disabled" },
        }),
        signal: AbortSignal.timeout(60_000),
      });
      const data = (await resp.json()) as { content: Array<{ type: string; text: string; thinking: string }>; error?: { message: string } };
      if (data.error) throw new Error(data.error.message);
      const textBlock = data.content?.find(c => c.type === "text" && c.text);
      const thinkBlock = data.content?.find(c => (c.type === "thinking" || c.thinking) && c.thinking);
      raw = textBlock?.text ?? thinkBlock?.thinking ?? "";
    } else {
      const resp = await fetch(`${settings.LLM_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${settings.LLM_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: settings.LLM_LIGHT_MODEL,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.2,
          max_tokens: 1024,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
      raw = data.choices?.[0]?.message?.content ?? "";
    }

    sessionLogger?.append(sid, "llm_self_eval", { prompt, response: raw });

    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return;
    const parsed = JSON.parse(m[0]);

    saveLlmSelfEval({
      ts: new Date().toISOString(),
      sid,
      scores: {
        completeness: Number(parsed.scores?.completeness) || 0,
        diversity: Number(parsed.scores?.diversity) || 0,
        budgetReasonableness: Number(parsed.scores?.budgetReasonableness) || 0,
        executability: Number(parsed.scores?.executability) || 0,
        creativity: Number(parsed.scores?.creativity) || 0,
      },
      failureCategory: parsed.failureCategory,
      notes: parsed.notes,
    });
  } catch {
    // self-eval is fire-and-forget, never throw
  }
}
