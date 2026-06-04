import { settings } from "../config/settings.js";
import type { ExtractedFields } from "./context.js";

function validateField(key: string, value: unknown): boolean {
  if (value === undefined || value === null) return false;

  if (key === "startDate" || key === "endDate") {
    if (typeof value !== "string") return false;
    const d = new Date(value);
    return !isNaN(d.getTime()) && d.getTime() > Date.now();
  }

  if (key === "budget") {
    return typeof value === "number" && value > 0;
  }

  if (key === "numTravelers") {
    return typeof value === "number" && value >= 1;
  }

  if (key === "travelInterests" || key === "foodPreferences") {
    return Array.isArray(value) && value.length > 0;
  }

  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  return true;
}

export class InfoExtractor {
  async extract(
    userMessage: string,
    history: Array<{ role: string; content: string }>,
    knownFields: Record<string, unknown>,
  ): Promise<ExtractedFields> {
    const nonEmptyKnown = Object.fromEntries(
      Object.entries(knownFields).filter(([, v]) => v !== undefined && v !== null && v !== ""),
    );

    const recentHistory = history.slice(-5);
    const formattedHistory = recentHistory
      .map((m) => `${m.role === "user" ? "用户" : "助手"}: ${m.content}`)
      .join("\n");

    const currentYear = new Date().getFullYear();

    const prompt = `你是一个旅行信息提取助手。从用户的消息中提取旅行相关信息，以JSON格式返回。

已收集信息：${JSON.stringify(nonEmptyKnown)}
对话历史（最近5条）：
${formattedHistory}

用户最新消息：${userMessage}

请提取以下字段（只返回你能确定的字段，不确定的不要返回）：
{
  "destination": "目的地城市",
  "departureCity": "出发城市",
  "startDate": "YYYY-MM-DD",
  "endDate": "YYYY-MM-DD",
  "numTravelers": 数字,
  "budget": 数字(元),
  "accommodationStyle": "budget|comfort|luxury",
  "travelInterests": ["兴趣1", "兴趣2"],
  "foodPreferences": ["偏好1"],
  "transportPreference": "flight|high_speed_rail|train|no_preference",
  "specialRequests": "特殊需求"
}

规则：
- 日期格式 YYYY-MM-DD，年份默认为${currentYear}
- "X个人"/"X人" -> numTravelers: X
- "X块钱"/"X元"/"预算X" -> budget: X
- "舒适"/"舒适型" -> accommodationStyle: "comfort"
- "经济"/"便宜" -> accommodationStyle: "budget"
- "豪华"/"高档" -> accommodationStyle: "luxury"
- "历史文化"/"胡同" -> travelInterests 中展开为 ["博物馆", "故宫", "胡同", "历史遗址"]
- "美食"/"吃货" -> travelInterests 中加入 "美食"
- "自然"/"风景" -> travelInterests 中加入 "自然风光"
- "购物" -> travelInterests 中加入 "购物"
- 只返回有把握的字段，不要猜测
- 返回纯JSON，不要有其他文字`;

    const raw = await this.callLlm(prompt);
    return this.parseResponse(raw);
  }

  private async callLlm(prompt: string): Promise<string> {
    const isAnthropic = settings.LLM_PROVIDER === "anthropic";

    if (isAnthropic) {
      return this.callAnthropic(prompt);
    }
    return this.callOpenAi(prompt);
  }

  private async callAnthropic(prompt: string): Promise<string> {
    const body: Record<string, unknown> = {
      model: settings.LLM_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: settings.LLM_TEMPERATURE,
      max_tokens: settings.LLM_MAX_TOKENS,
    };

    const resp = await fetch(`${settings.LLM_BASE_URL}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": settings.LLM_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    const data = (await resp.json()) as {
      content: Array<{ type: string; text: string }>;
      error?: { message: string };
    };
    if (data.error) throw new Error(`Anthropic API error: ${data.error.message}`);
    return data.content[0].text;
  }

  private async callOpenAi(prompt: string): Promise<string> {
    const resp = await fetch(`${settings.LLM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.LLM_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: settings.LLM_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: settings.LLM_TEMPERATURE,
        max_tokens: settings.LLM_MAX_TOKENS,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    const data = (await resp.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices[0].message.content;
  }

  private parseResponse(raw: string): ExtractedFields {
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return {};

      const parsed = JSON.parse(match[0]) as Record<string, unknown>;
      const result: ExtractedFields = {};

      const allowedKeys: Array<keyof ExtractedFields> = [
        "destination",
        "departureCity",
        "startDate",
        "endDate",
        "numTravelers",
        "budget",
        "accommodationStyle",
        "travelInterests",
        "foodPreferences",
        "transportPreference",
        "specialRequests",
      ];

      for (const key of allowedKeys) {
        const value = parsed[key];
        if (value !== undefined && validateField(key, value)) {
          (result as Record<string, unknown>)[key] = value;
        }
      }

      return result;
    } catch {
      return {};
    }
  }
}
