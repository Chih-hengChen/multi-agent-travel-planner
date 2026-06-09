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

const cityKnowledgeCache = new Map<string, { content: string; fetchedAt: number }>();
const CACHE_TTL = 24 * 60 * 60 * 1000;

const TOURISM_KEYWORDS = [
  "景点", "名胜", "旅游", "古迹", "博物馆", "公园", "寺", "庙", "宫",
  "园", "陵", "楼", "塔", "故居", "纪念", "风景", "世界遗产", "文化遗产",
  "5A", "4A", "AAAA", "网红", "打卡",
];

const RELEVANCE_KEYWORDS: Record<string, string[]> = {
  trains: ["高铁", "动车", "车次", "列车", "火车", "时刻表", "二等座", "G", "D"],
  flights: ["航班", "机票", "航空", "起飞", "降落", "CA", "MU", "CZ", "HU"],
};

export class WebSearchSource implements TravelDataSource {
  constructor(private readonly logger: Logger) {}

  async searchFlights(params: FlightSearchParams): Promise<Flight[]> {
    const query = `${params.origin}到${params.destination}机票价格航班时刻表`;
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
    const queries = [
      `${params.from}到${params.to}高铁票车次查询`,
      `${params.from}到${params.to}火车时刻表`,
      `${params.from} ${params.to} 高铁 G车次`,
    ];

    for (const query of queries) {
      const results = await this.searchAndParse<Train>(query, "trains", (raw) => {
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
      if (results.length > 0) return results;
      this.logger.info({ query: query.substring(0, 50) }, "web-search: train query retry");
    }

    this.logger.info({ from: params.from, to: params.to }, "web-search: all train queries failed, using LLM knowledge");
    return this.searchAndParse<Train>(
      `${params.from}到${params.to}高铁`,
      "trains",
      (raw) => {
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
      },
      { allowLlmFallback: true },
    );
  }

  async searchHotels(params: HotelSearchParams): Promise<Hotel[]> {
    const query = `${params.city}酒店推荐价格${params.maxPricePerNight ? ` ${params.maxPricePerNight}元以内` : ""}`;
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
    const cityKnowledge = await this.getCityKnowledge(params.city);
    const query = `${params.city}${params.interests?.join("") ?? ""}景点推荐门票`;
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
    }, { cityKnowledge });
  }

  async searchRestaurants(params: RestaurantSearchParams): Promise<Activity[]> {
    const cityKnowledge = await this.getCityKnowledge(params.city);
    const query = `${params.city}${params.mealType === "dinner" ? "晚餐" : params.mealType === "lunch" ? "午餐" : "早餐"}推荐美食人均消费`;
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
    }, { cityKnowledge });
  }

  private async searchAndParse<T>(query: string, kind: string, mapper: (raw: unknown) => T | null, opts?: { cityKnowledge?: string; allowLlmFallback?: boolean }): Promise<T[]> {
    try {
      const searchResults = await this.searchWeb(query);
      if (searchResults.length === 0) {
        this.logger.info({ kind, query: query.substring(0, 50) }, "web-search: no results from daemon");
        if (opts?.allowLlmFallback) {
          return this.llmFallbackExtract(query, kind, mapper);
        }
        return [];
      }

      const contents = await this.fetchWebContent(searchResults, 3);
      const searchContext = this.formatSearchResults(searchResults, contents);

      this.logger.info({ kind, searchResults: searchResults.length, ctxLen: searchContext.length, ctxSample: searchContext.substring(0, 300) }, "web-search: context");

      if (!this.isRelevant(searchContext, kind)) {
        this.logger.info({ kind, query: query.substring(0, 50) }, "web-search: results irrelevant");
        if (opts?.allowLlmFallback) {
          return this.llmFallbackExtract(query, kind, mapper);
        }
        return [];
      }

      const llmResponse = await this.extractWithLlm(searchContext, query, kind, opts?.cityKnowledge);
      const json = this.extractJson(llmResponse);
      if (!Array.isArray(json)) {
        this.logger.warn({ kind, text: llmResponse.substring(0, 200) }, "web-search: LLM extraction returned no valid JSON");
        if (opts?.allowLlmFallback) {
          return this.llmFallbackExtract(query, kind, mapper);
        }
        return [];
      }

      this.logger.info({ kind, jsonLen: json.length, sample: json[0] ? JSON.stringify(json[0]).substring(0, 300) : "empty" }, "web-search: LLM raw json");
      const results: T[] = [];
      for (const item of json) {
        const mapped = mapper(item);
        if (!mapped) {
          this.logger.info({ kind, item: JSON.stringify(item).substring(0, 200) }, "web-search: mapper filtered item");
        }
        if (mapped) results.push(mapped);
      }
      this.logger.info({ kind, query: query.substring(0, 50), results: results.length }, "web-search: parsed");
      return results;
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : String(err), kind }, "web-search: failed");
      return [];
    }
  }

  private isRelevant(searchContext: string, kind: string): boolean {
    const keywords = RELEVANCE_KEYWORDS[kind];
    if (!keywords) return true;
    return keywords.some(kw => searchContext.includes(kw));
  }

  private async llmFallbackExtract<T>(query: string, kind: string, mapper: (raw: unknown) => T | null): Promise<T[]> {
    this.logger.info({ kind, query: query.substring(0, 50) }, "web-search: using LLM knowledge fallback");
    const prompt = webSearchPrompt.buildFallbackPrompt({ query, kind });
    const llmResponse = await this.extractWithLlm("", query, kind, undefined, prompt);
    const json = this.extractJson(llmResponse);
    if (!Array.isArray(json)) return [];

    const results: T[] = [];
    for (const item of json) {
      const mapped = mapper(item);
      if (mapped) results.push(mapped);
    }
    this.logger.info({ kind, results: results.length, source: "llm-fallback" }, "web-search: parsed");
    return results;
  }

  private async searchWebViaFirecrawl(query: string): Promise<SearchResultItem[]> {
    if (!settings.FIRECRAWL_API_KEY || !settings.FIRECRAWL_ENABLED) return [];

    try {
      const resp = await fetch("https://api.firecrawl.dev/v2/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${settings.FIRECRAWL_API_KEY}`,
        },
        body: JSON.stringify({ query, limit: 8 }),
        signal: AbortSignal.timeout(20_000),
      });

      if (!resp.ok) {
        this.logger.warn({ status: resp.status }, "web-search/firecrawl: request failed");
        return [];
      }

      const body = await resp.json() as {
        success: boolean;
        data?: { web?: Array<{ title?: string; url?: string; description?: string }> };
      };

      if (!body.success || !body.data?.web?.length) {
        this.logger.info("web-search/firecrawl: no results");
        return [];
      }

      const items: SearchResultItem[] = [];
      for (const r of body.data.web) {
        if (!r.url) continue;
        items.push({
          title: r.title ?? "",
          url: r.url,
          description: r.description ?? "",
          source: "firecrawl",
          engine: "firecrawl",
        });
      }

      this.logger.info({ count: items.length, query: query.substring(0, 50) }, "web-search/firecrawl: results");
      return items;
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : String(err) }, "web-search/firecrawl: failed");
      return [];
    }
  }

  private async searchWeb(query: string): Promise<SearchResultItem[]> {
    try {
      const resp = await fetch(`${settings.WEBSEARCH_DAEMON_URL}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, limit: 8, engines: ["baidu", "sogou", "bing"] }),
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
    }

    const fcResults = await this.searchWebViaFirecrawl(query);
    if (fcResults.length > 0) return fcResults;
    return [];
  }

  private async fetchWebContent(items: SearchResultItem[], maxItems: number): Promise<Map<number, string>> {
    const result = new Map<number, string>();
    const targets = items.slice(0, maxItems);

    const settled = await Promise.allSettled(
      targets.map(async (item, i) => {
        const resp = await fetch(`${settings.WEBSEARCH_DAEMON_URL}/fetch-web`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: item.url, maxChars: 5000 }),
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
        result.set(r.value.index, this.cleanWebContent(r.value.content).substring(0, 3000));
      }
    }

    return result;
  }

  private cleanWebContent(content: string): string {
    return content.split(/\n/).filter((line) => {
      const t = line.trim();
      if (t.length < 4) return false;
      if (/^(?:登录|注册|我的订单|联系客服|旅游首页|关于我们|帮助中心|网站导航|宾馆索引|攻略索引|机票索引)$/i.test(t)) return false;
      if (/^(?:酒店机票|特价机票|火车票|国内租车|境外租车|礼品卡|企业商旅|跟团游|自由行|邮轮|签证保险|企业会奖).{0,10}$/.test(t)) return false;
      if (/^[▪●►◆◇○·•┃▸▹▶]+$/.test(t)) return false;
      return true;
    }).join("\n");
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

  private async extractWithLlm(searchContext: string, query: string, kind: string, cityKnowledge?: string, customPrompt?: string): Promise<string> {
    const prompt = customPrompt ?? webSearchPrompt.buildUserPrompt({ query, kind, searchContext, cityKnowledge });
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

  async getCityKnowledge(city: string): Promise<string> {
    const cached = cityKnowledgeCache.get(city);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
      this.logger.info({ city, source: "cached" }, "city-knowledge: hit");
      return cached.content;
    }

    try {
      const results = await this.searchWeb(`${city}旅游百科`);
      if (results.length === 0) {
        this.logger.info({ city }, "city-knowledge: no search results");
        cityKnowledgeCache.set(city, { content: "", fetchedAt: Date.now() });
        return "";
      }

      const baikeItem = results.find(r =>
        /baike|wiki|百科|wenwen|zhidao/.test(r.url),
      ) ?? results[0];

      const contents = await this.fetchWebContent([baikeItem], 1);
      const rawContent = contents.get(0) ?? "";

      if (!rawContent) {
        const fallback = results.slice(0, 3).map(r => r.description).filter(Boolean).join("\n");
        cityKnowledgeCache.set(city, { content: fallback, fetchedAt: Date.now() });
        this.logger.info({ city, source: "descriptions", len: fallback.length }, "city-knowledge: fallback");
        return fallback;
      }

      const tourismContent = this.extractTourismSections(rawContent);
      cityKnowledgeCache.set(city, { content: tourismContent, fetchedAt: Date.now() });
      this.logger.info({ city, source: "baike", len: tourismContent.length }, "city-knowledge: fetched");
      return tourismContent;
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : String(err), city }, "city-knowledge: failed");
      return "";
    }
  }

  private extractTourismSections(content: string): string {
    const lines = content.split(/\n/);
    const matched = new Set<number>();

    for (let i = 0; i < lines.length; i++) {
      if (TOURISM_KEYWORDS.some(kw => lines[i].includes(kw))) {
        for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 1); j++) {
          matched.add(j);
        }
      }
    }

    const result = [...matched].sort((a, b) => a - b).map(i => lines[i]).join("\n");
    return result.substring(0, 3000);
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
