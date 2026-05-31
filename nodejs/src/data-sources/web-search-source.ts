import type { Logger } from "pino";
import type { TravelDataSource, FlightSearchParams, HotelSearchParams, AttractionSearchParams, TrainSearchParams, RestaurantSearchParams } from "./types.js";
import type { Flight, Hotel, Activity, Train } from "../types/index.js";
import { settings } from "../config/settings.js";

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
      const prompt = `搜索以下信息并以JSON数组返回结果。只返回纯JSON，不要其他文字。

查询：${query}

返回格式：JSON数组，每个元素包含相关的${kind}信息。如果没有可靠数据，返回空数组 []。`;

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
        body.system = `你是一个数据搜索助手。根据用户的查询，从你的知识库中提供最准确的${kind}数据。只返回JSON。`;
      } else {
        headers["Authorization"] = `Bearer ${settings.LLM_API_KEY}`;
        body.messages = [
          { role: "system", content: `你是一个数据搜索助手。根据用户的查询，从你的知识库中提供最准确的${kind}数据。只返回JSON。` },
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
        return [];
      }

      const data = await resp.json() as any;
      const text = isAnthropic
        ? data.content?.[0]?.text ?? ""
        : data.choices?.[0]?.message?.content ?? "";

      const json = this.extractJson(text);
      if (!Array.isArray(json)) {
        this.logger.warn({ kind, text: text.substring(0, 200) }, "web-search: no valid JSON array");
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
