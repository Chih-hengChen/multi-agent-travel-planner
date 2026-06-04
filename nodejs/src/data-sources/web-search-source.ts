import type { Logger } from "pino";
import type { TravelDataSource, FlightSearchParams, HotelSearchParams, AttractionSearchParams, TrainSearchParams, RestaurantSearchParams } from "./types.js";
import type { Flight, Hotel, Activity, Train } from "../types/index.js";
import { settings } from "../config/settings.js";
import * as webSearchPrompt from "../prompts/web-search.js";

interface SearchResultItem {
  title: string;
  url: string;
  description: string;
  source?: string;
  engine?: string;
}

export class WebSearchSource implements TravelDataSource {
  constructor(private readonly logger: Logger) {}

  async searchFlights(params: FlightSearchParams): Promise<Flight[]> {
    const query = `${params.origin} ${params.destination} 机票 ${params.departureDate} 价格 航班号 时刻表`;
    return this.searchAndParse<Flight>(query, "flights", (raw) => {
      const d = raw as Record<string, unknown>;
      const flightNo = String(d.flightNo ?? d.flight_no ?? "");
      if (!flightNo) return null;
      return {
        airline: String(d.airline ?? ""),
        flightNo,
        departureCity: params.origin,
        arrivalCity: params.destination,
        departureTime: `${params.departureDate}T${String(d.departureTime ?? d.departure_time ?? "08:00").replace(/^(\d{1,2}):(\d{2})$/, (_, h, m) => `${h.padStart(2, "0")}:${m}`)}`,
        arrivalTime: `${params.departureDate}T${String(d.arrivalTime ?? d.arrival_time ?? "11:00").replace(/^(\d{1,2}):(\d{2})$/, (_, h, m) => `${h.padStart(2, "0")}:${m}`)}`,
        price: Number(d.price ?? 0) || 0,
        durationHours: Number(d.durationHours ?? d.duration_hours ?? 2) || 2,
        stops: 0,
        cabinClass: "economy",
      };
    });
  }

  async searchTrains(params: TrainSearchParams): Promise<Train[]> {
    const query = `${params.from} ${params.to} 高铁 G次 ${params.date} 时刻表 价格 二等座`;
    return this.searchAndParse<Train>(query, "trains", (raw) => {
      const d = raw as Record<string, unknown>;
      const trainNo = String(d.trainNo ?? d.train_no ?? "");
      if (!trainNo) return null;
      return {
        trainNo,
        trainType: String(d.trainType ?? d.train_type ?? "高铁"),
        departureCity: String(d.departureCity ?? d.departure_city ?? params.from),
        arrivalCity: String(d.arrivalCity ?? d.arrival_city ?? params.to),
        departureTime: String(d.departureTime ?? d.departure_time ?? ""),
        arrivalTime: String(d.arrivalTime ?? d.arrival_time ?? ""),
        price: Number(d.price ?? 0) || 0,
        durationHours: Number(d.durationHours ?? d.duration_hours ?? 3) || 3,
        seatType: String(d.seatType ?? d.seat_type ?? "二等座"),
      };
    });
  }

  async searchHotels(params: HotelSearchParams): Promise<Hotel[]> {
    const query = `${params.city} 酒店 ${params.checkIn} ${params.checkOut} 携程 ${params.maxPricePerNight ? `预算${params.maxPricePerNight}元内` : ""}`;
    return this.searchAndParse<Hotel>(query, "hotels", (raw) => {
      const d = raw as Record<string, unknown>;
      const name = String(d.name ?? "");
      if (!name) return null;
      return {
        name,
        city: params.city,
        address: String(d.address ?? ""),
        starRating: Number(d.starRating ?? d.star_rating ?? 3) || 3,
        userRating: Number(d.userRating ?? d.user_rating ?? 8) || 8,
        pricePerNight: Number(d.pricePerNight ?? d.price_per_night ?? 0) || 0,
        amenities: Array.isArray(d.amenities) ? d.amenities.map(String) : [],
        distanceToCenterKm: Number(d.distanceToCenterKm ?? d.distance_to_center ?? 0) || 0,
      };
    });
  }

  async searchAttractions(params: AttractionSearchParams): Promise<Activity[]> {
    const query = `${params.city} ${params.interests?.join(" ") ?? ""} 景点推荐 门票 开放时间`;
    return this.searchAndParse<Activity>(query, "attractions", (raw) => {
      const d = raw as Record<string, unknown>;
      const name = String(d.name ?? "");
      if (!name) return null;
      return {
        name,
        category: String(d.category ?? "景点"),
        location: String(d.location ?? params.city),
        durationHours: Number(d.durationHours ?? 2) || 2,
        price: Number(d.price ?? d.ticketPrice ?? 0) || 0,
        rating: Number(d.rating ?? 8) || 8,
        description: "",
        timeSlot: "",
      };
    });
  }

  async searchRestaurants(params: RestaurantSearchParams): Promise<Activity[]> {
    const query = `${params.city} ${params.mealType === "dinner" ? "晚餐" : params.mealType === "lunch" ? "午餐" : "早餐"} 推荐 美食 人均`;
    return this.searchAndParse<Activity>(query, "restaurants", (raw) => {
      const d = raw as Record<string, unknown>;
      const name = String(d.name ?? "");
      if (!name) return null;
      return {
        name,
        category: "dining",
        location: String(d.location ?? params.city),
        durationHours: params.mealType === "dinner" ? 2 : 1,
        price: Number(d.price ?? d.pricePerPerson ?? 0) || 0,
        rating: Number(d.rating ?? 8) || 8,
        description: String(d.cuisine ?? ""),
        timeSlot: params.mealType === "breakfast" ? "morning" : params.mealType === "lunch" ? "afternoon" : "evening",
      };
    });
  }

  private async searchAndParse<T>(query: string, kind: string, mapper: (raw: unknown) => T | null): Promise<T[]> {
    try {
      const searchResults = await this.searchWeb(query);
      if (searchResults.length === 0) {
        this.logger.info({ kind, query: query.substring(0, 50) }, "web-search: no results from daemon");
        return [];
      }

      const contents = await this.fetchWebContent(searchResults, 3);
      const searchContext = this.formatSearchResults(searchResults, contents);

      const llmResponse = await this.extractWithLlm(searchContext, query, kind);
      const json = this.extractJson(llmResponse);
      if (!Array.isArray(json)) {
        this.logger.warn({ kind, text: llmResponse.substring(0, 200) }, "web-search: LLM extraction returned no valid JSON");
        return [];
      }

      const results: T[] = [];
      for (const item of json) {
        const mapped = mapper(item);
        if (mapped) results.push(mapped);
      }
      this.logger.info({ kind, query: query.substring(0, 50), results: results.length }, "web-search: parsed");
      return results;
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : String(err), kind }, "web-search: failed");
      return [];
    }
  }

  private async searchWeb(query: string): Promise<SearchResultItem[]> {
    try {
      const resp = await fetch(`${settings.WEBSEARCH_DAEMON_URL}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, limit: 8, engines: ["sogou", "bing"] }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!resp.ok) {
        this.logger.warn({ status: resp.status }, "web-search: daemon /search failed");
        return [];
      }

      const body = await resp.json() as Record<string, unknown>;
      if (body.status === "ok" && body.data && typeof body.data === "object") {
        const d = body.data as Record<string, unknown>;
        if (Array.isArray(d.results)) {
          return d.results as SearchResultItem[];
        }
        if (Array.isArray(body.data)) {
          return body.data as SearchResultItem[];
        }
      }
      if (Array.isArray(body)) {
        return body as unknown as SearchResultItem[];
      }
      return [];
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : String(err) }, "web-search: daemon unreachable");
      return [];
    }
  }

  private async fetchWebContent(items: SearchResultItem[], maxItems: number): Promise<Map<number, string>> {
    const result = new Map<number, string>();
    const targets = items.slice(0, maxItems);

    const settled = await Promise.allSettled(
      targets.map(async (item, i) => {
        const resp = await fetch(`${settings.WEBSEARCH_DAEMON_URL}/fetch-web`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: item.url, maxChars: 3000 }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!resp.ok) return null;
        const body = await resp.json() as { status: string; data?: { content?: string } };
        const content = body.status === "ok" ? body.data?.content : (body as Record<string, unknown>).content;
        return { index: i, content: typeof content === "string" ? content : null };
      }),
    );

    for (const r of settled) {
      if (r.status === "fulfilled" && r.value?.content) {
        result.set(r.value.index, r.value.content.substring(0, 3000));
      }
    }

    return result;
  }

  private formatSearchResults(items: SearchResultItem[], contents: Map<number, string>): string {
    const parts: string[] = [];
    let totalLen = 0;
    const MAX_LEN = 8000;

    for (let i = 0; i < items.length && totalLen < MAX_LEN; i++) {
      const item = items[i];
      const desc = item.description?.substring(0, 500) ?? "";
      let block = `来源${i + 1}: ${item.title}\n${desc}`;
      const fetched = contents.get(i);
      if (fetched) {
        block += `\n详情: ${fetched.substring(0, 2000)}`;
      }
      block += `\nURL: ${item.url}`;
      if (totalLen + block.length > MAX_LEN) {
        block = block.substring(0, MAX_LEN - totalLen);
      }
      parts.push(block);
      totalLen += block.length;
    }

    return parts.join("\n\n");
  }

  private async extractWithLlm(searchContext: string, query: string, kind: string): Promise<string> {
    const prompt = webSearchPrompt.buildUserPrompt({ query, kind, searchContext });
    const systemPrompt = webSearchPrompt.buildSystemPrompt({ kind });

    const body: Record<string, unknown> = {
      model: settings.LLM_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 2048,
    };

    const isAnthropic = settings.LLM_PROVIDER === "anthropic";
    const url = isAnthropic
      ? `${settings.LLM_BASE_URL}/v1/messages`
      : `${settings.LLM_BASE_URL}/chat/completions`;

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (isAnthropic) {
      headers["x-api-key"] = settings.LLM_API_KEY;
      headers["anthropic-version"] = "2023-06-01";
      body.system = systemPrompt;
    } else {
      headers["Authorization"] = `Bearer ${settings.LLM_API_KEY}`;
      body.messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ];
    }

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      this.logger.warn({ kind, status: resp.status }, "web-search: LLM call failed");
      return "";
    }

    const data = await resp.json() as any;
    return isAnthropic
      ? data.content?.[0]?.text ?? ""
      : data.choices?.[0]?.message?.content ?? "";
  }

  private extractJson(text: string): unknown {
    const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlock) {
      try { return JSON.parse(codeBlock[1].trim()); } catch { /* fallback */ }
    }
    const bracketMatch = text.match(/\[[\s\S]*\]/);
    if (bracketMatch) {
      try { return JSON.parse(bracketMatch[0]); } catch { /* fallback */ }
    }
    return null;
  }
}
