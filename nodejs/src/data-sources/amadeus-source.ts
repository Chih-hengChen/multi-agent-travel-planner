import { settings } from "../config/settings.js";
import type { Flight } from "../types/index.js";
import type { FlightSearchParams, TravelDataSource, HotelSearchParams, AttractionSearchParams, TrainSearchParams } from "./types.js";

const TOKEN_TTL_MS = 1700_000;
let cachedToken = "";
let tokenExpiresAt = 0;

const IATA_MAP: Record<string, string> = {
  "北京": "PEK", "上海": "PVG", "广州": "CAN", "深圳": "SZX",
  "成都": "CTU", "杭州": "HGH", "武汉": "WUH", "西安": "XIY",
  "重庆": "CKG", "南京": "NKG", "长沙": "CSX", "青岛": "TAO",
  "大连": "DLC", "厦门": "XMN", "昆明": "KMG", "三亚": "SYX",
  "哈尔滨": "HRB", "天津": "TSN", "郑州": "CGO", "福州": "FOC",
  "东京": "TYO", "大阪": "OSA", "首尔": "ICN", "曼谷": "BKK",
  "新加坡": "SIN", "香港": "HKG", "台北": "TPE", "吉隆坡": "KUL",
  "巴黎": "PAR", "伦敦": "LON", "纽约": "NYC", "洛杉矶": "LAX",
  "悉尼": "SYD", "迪拜": "DXB",
};

function cityToIATA(city: string): string {
  return IATA_MAP[city] ?? city.toUpperCase().slice(0, 3);
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  if (!settings.AMADEUS_API_KEY || !settings.AMADEUS_API_SECRET) {
    throw new Error("AMADEUS_API_KEY 或 AMADEUS_API_SECRET 未配置");
  }
  const resp = await fetch("https://api.amadeus.com/v1/security/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: settings.AMADEUS_API_KEY,
      client_secret: settings.AMADEUS_API_SECRET,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Amadeus auth failed (${resp.status}): ${text}`);
  }
  const data = await resp.json() as { access_token: string; expires_in: number };
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + Math.min(data.expires_in * 1000, TOKEN_TTL_MS);
  return cachedToken;
}

function parseDuration(iso: string): number {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return 0;
  return parseInt(m[1] ?? "0") + parseInt(m[2] ?? "0") / 60;
}

export class AmadeusSource implements TravelDataSource {
  async searchFlights(params: FlightSearchParams): Promise<Flight[]> {
    try {
      const token = await getAccessToken();
      const origin = cityToIATA(params.origin);
      const destination = cityToIATA(params.destination);
      const qs = new URLSearchParams({
        originLocationCode: origin,
        destinationLocationCode: destination,
        departureDate: params.departureDate,
        adults: String(params.adults),
        currencyCode: "CNY",
        max: "10",
      });
      if (params.maxPrice) qs.set("maxPrice", String(Math.round(params.maxPrice)));

      const resp = await fetch(`https://api.amadeus.com/v2/shopping/flight-offers?${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Amadeus flight search failed (${resp.status}): ${text}`);
      }
      const data = await resp.json() as {
        data: Array<{
          id: string;
          price: { total: string };
          itineraries: Array<{
            duration: string;
            segments: Array<{
              carrierCode: string;
              number: string;
              departure: { iataCode: string; at: string };
              arrival: { iataCode: string; at: string };
            }>;
          }>;
        }>;
      };

      return (data.data ?? []).map((offer) => {
        const seg = offer.itineraries[0]?.segments?.[0];
        if (!seg) return null;
        const hours = parseDuration(offer.itineraries[0]?.duration ?? "PT0H");
        return {
          airline: seg.carrierCode,
          flightNo: `${seg.carrierCode}${seg.number}`,
          departureCity: params.origin,
          arrivalCity: params.destination,
          departureTime: seg.departure.at,
          arrivalTime: seg.arrival.at,
          price: Math.round(parseFloat(offer.price.total)),
          durationHours: Math.round(hours * 10) / 10,
          stops: Math.max(0, (offer.itineraries[0]?.segments?.length ?? 1) - 1),
          cabinClass: "economy",
        } satisfies Flight;
      }).filter((f): f is Flight => f !== null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[AmadeusSource] 航班搜索失败: ${msg}`);
      return [];
    }
  }

  async searchHotels(_params: HotelSearchParams): Promise<never[]> {
    return [];
  }

  async searchAttractions(_params: AttractionSearchParams): Promise<never[]> {
    return [];
  }

  async searchTrains(_params: TrainSearchParams): Promise<never[]> {
    return [];
  }
}
