import type { ConversationContext } from "../conversation/context.js";
import { getMissingBasics, getMissingPreferences } from "../conversation/context.js";
import { ConversationState } from "../conversation/state-machine.js";
import { settings } from "../config/settings.js";
import * as gatheringPrompt from "../prompts/gathering-question.js";

const FIELD_LABELS: Record<string, string> = {
  destination: "目的地",
  departureCity: "出发城市",
  startDate: "出发日期",
  endDate: "返回日期",
  numTravelers: "出行人数",
  budget: "旅行预算",
  accommodationStyle: "住宿偏好",
  travelInterests: "感兴趣的游玩类型",
  transportPreference: "交通方式偏好（高铁/飞机/不限）",
};

export class GatheringAgent {
  async generateQuestion(
    ctx: ConversationContext,
  ): Promise<{ text: string; fields: string[] }> {
    const missing = this.getMissingFields(ctx);
    if (missing.length === 0) return { text: "", fields: [] };

    const fields = missing.slice(0, 3);
    const text = await this.llmQuestion(ctx, fields);
    return { text, fields };
  }

  private getMissingFields(ctx: ConversationContext): string[] {
    if (
      ctx.state === ConversationState.INIT ||
      ctx.state === ConversationState.GATHERING_BASICS
    ) {
      return getMissingBasics(ctx);
    }
    if (ctx.state === ConversationState.GATHERING_PREFERENCES) {
      return getMissingPreferences(ctx);
    }
    return [];
  }

  private async llmQuestion(
    ctx: ConversationContext,
    fields: string[],
  ): Promise<string> {
    const known = this.formatKnown(ctx);
    const missing = fields.map((f) => FIELD_LABELS[f] ?? f).join("、");

    const prompt = gatheringPrompt.build({
      known,
      missing,
      maxFields: fields.length,
    });

    return this.callLlm(prompt);
  }

  private formatKnown(ctx: ConversationContext): string {
    const pairs: string[] = [];
    if (ctx.destination) pairs.push(`目的地: ${ctx.destination}`);
    if (ctx.departureCity) pairs.push(`出发城市: ${ctx.departureCity}`);
    if (ctx.startDate) pairs.push(`出发日期: ${ctx.startDate}`);
    if (ctx.endDate) pairs.push(`返回日期: ${ctx.endDate}`);
    if (ctx.numTravelers) pairs.push(`人数: ${ctx.numTravelers}`);
    if (ctx.budget) pairs.push(`预算: ${ctx.budget}元`);
    if (ctx.accommodationStyle) pairs.push(`住宿偏好: ${ctx.accommodationStyle}`);
    if (ctx.travelInterests?.length) pairs.push(`兴趣: ${ctx.travelInterests.join("、")}`);
    return pairs.join("，");
  }

  private async callLlm(prompt: string): Promise<string> {
    const isAnthropic = settings.LLM_PROVIDER === "anthropic";
    const messages: Array<{ role: string; content: string }> = [];
    messages.push({ role: "user", content: prompt });

    if (isAnthropic) {
      const resp = await fetch(`${settings.LLM_BASE_URL}/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": settings.LLM_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: settings.LLM_LIGHT_MODEL,
          messages,
          temperature: settings.LLM_TEMPERATURE,
          max_tokens: settings.LLM_MAX_TOKENS,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      const data = (await resp.json()) as { content: Array<{ type: string; text: string }>; error?: { message: string } };
      if (data.error) throw new Error(`Anthropic API error: ${data.error.message}`);
      return data.content[0].text;
    }

    const resp = await fetch(`${settings.LLM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.LLM_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: settings.LLM_LIGHT_MODEL,
        messages,
        temperature: settings.LLM_TEMPERATURE,
        max_tokens: settings.LLM_MAX_TOKENS,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices[0].message.content;
  }
}
