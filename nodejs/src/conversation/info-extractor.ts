import { settings } from "../config/settings.js";
import type { ExtractedFields } from "./context.js";
import * as infoExtractPrompt from "../prompts/info-extract.js";

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

    const today = new Date();
    const currentDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

    const prompt = infoExtractPrompt.build({
      knownFields: nonEmptyKnown,
      history: formattedHistory,
      userMessage,
      currentDate,
    });

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
      model: settings.LLM_LIGHT_MODEL,
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
        model: settings.LLM_LIGHT_MODEL,
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
