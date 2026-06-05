import type { Logger } from "pino";
import type { Train } from "../types/index.js";
import type { TravelDataSource, FlightSearchParams, HotelSearchParams, AttractionSearchParams, TrainSearchParams, RestaurantSearchParams } from "./types.js";
import { settings } from "../config/settings.js";

const API_BASE = "https://kyfw.12306.cn";
const WEB_BASE = "https://www.12306.cn/index/";

const SEAT_TYPE_NAMES: Record<string, string> = {
  "9": "商务座", P: "特等座", M: "一等座", D: "优选一等座",
  O: "二等座", S: "二等包座", "6": "高级软卧", A: "高级动卧",
  "4": "软卧", I: "一等卧", F: "动卧", "3": "硬卧", J: "二等卧",
  "2": "软座", "1": "硬座", W: "无座",
};

const SEAT_SHORT: Record<string, string> = {
  "9": "swz", P: "tz", M: "zy", D: "zy", O: "ze", S: "ze",
  "6": "gr", A: "gr", "4": "rw", I: "rw", F: "rw",
  "3": "yw", J: "yw", "2": "rz", "1": "yz", W: "wz",
};

const TICKET_FIELDS = [
  "secret_Sstr", "button_text_info", "train_no", "station_train_code",
  "start_station_telecode", "end_station_telecode", "from_station_telecode",
  "to_station_telecode", "start_time", "arrive_time", "lishi", "canWebBuy",
  "yp_info", "start_train_date", "train_seat_feature", "location_code",
  "from_station_no", "to_station_no", "is_support_card", "controlled_train_flag",
  "gg_num", "gr_num", "qt_num", "rw_num", "rz_num", "tz_num", "wz_num",
  "yb_num", "yw_num", "yz_num", "ze_num", "zy_num", "swz_num", "srrb_num",
  "yp_ex", "seat_types", "exchange_train_flag", "houbu_train_flag",
  "houbu_seat_limit", "yp_info_new", "40", "41", "42", "43", "44", "45",
  "dw_flag", "47", "stopcheckTime", "country_flag", "local_arrive_time",
  "local_start_time", "52", "bed_level_info", "seat_discount_info",
  "sale_time", "56",
];

function inferTrainType(code: string): string {
  const c = code[0];
  if (c === "G") return "高铁";
  if (c === "D") return "动车";
  if (c === "C") return "城际";
  if (c === "Z") return "直达";
  if (c === "T") return "特快";
  if (c === "K") return "快速";
  return "普通";
}

function parseDuration(lishi: string): number {
  const parts = lishi.split(":");
  return parseInt(parts[0] ?? "0", 10) + parseInt(parts[1] ?? "0", 10) / 60;
}

function hasTickets(num: string): boolean {
  return num !== "--" && num !== "" && num !== "无" && num !== "*";
}

interface StationInfo {
  code: string;
  name: string;
  city: string;
}

export class Train12306Source implements TravelDataSource {
  private stationByCity: Map<string, StationInfo[]> | null = null;
  private nameToCode: Map<string, string> | null = null;
  private cookieString: string | null = null;

  constructor(private readonly logger: Logger) {}

  async searchTrains(params: TrainSearchParams): Promise<Train[]> {
    if (!settings.TRAIN_12306_ENABLED) return [];

    try {
      await this.ensureStations();
      const fromCode = this.resolveStation(params.from);
      const toCode = this.resolveStation(params.to);
      if (!fromCode || !toCode) {
        this.logger.warn({ from: params.from, to: params.to }, "12306: station not resolved");
        return [];
      }

      const trains = await this.queryAndParse(params.date, fromCode, toCode, params);
      if (trains.length > 0) return trains;

      this.cookieString = null;
      return this.queryAndParse(params.date, fromCode, toCode, params);
    } catch (err) {
      this.logger.warn({ err: String(err) }, "12306: query failed");
      return [];
    }
  }

  async searchFlights(_params: FlightSearchParams): Promise<never[]> { return []; }
  async searchHotels(_params: HotelSearchParams): Promise<never[]> { return []; }
  async searchAttractions(_params: AttractionSearchParams): Promise<never[]> { return []; }
  async searchRestaurants(_params: RestaurantSearchParams): Promise<never[]> { return []; }

  private async ensureStations(): Promise<void> {
    if (this.stationByCity) return;

    const indexHtml = await this.fetchText(WEB_BASE);
    const jsMatch = indexHtml.match(/\.\/(script\/core\/common\/station_name[^"']*\.js)/);
    if (!jsMatch) throw new Error("station_name.js URL not found");

    const jsContent = await this.fetchText(`${WEB_BASE}${jsMatch[1]}`);
    const strMatch = jsContent.match(/var\s+station_names\s*=\s*'([^']+)'/);
    if (!strMatch) throw new Error("station data not found in JS");

    const entries = strMatch[1].split("@").filter(Boolean);
    const byCity = new Map<string, StationInfo[]>();
    const byName = new Map<string, string>();

    for (const entry of entries) {
      const fields = entry.split("|");
      if (fields.length < 8) continue;
      const info: StationInfo = {
        code: fields[2]!,
        name: fields[1]!,
        city: fields[7]!,
      };
      let list = byCity.get(info.city);
      if (!list) { list = []; byCity.set(info.city, list); }
      list.push(info);
      byName.set(info.name, info.code);
    }
    for (const [city, stations] of byCity) {
      if (!byName.has(city) && stations.length > 0) {
        byName.set(city, stations[0]!.code);
      }
    }
    this.stationByCity = byCity;
    this.nameToCode = byName;
    this.logger.info({ stations: byName.size }, "12306: station data loaded");
  }

  private resolveStation(city: string): string | null {
    const name = city.endsWith("站") ? city.slice(0, -1) : city;
    return this.nameToCode?.get(name) ?? null;
  }

  private async ensureCookie(): Promise<string | null> {
    if (this.cookieString) return this.cookieString;
    try {
      const resp = await fetch(`${API_BASE}/otn/leftTicket/init`, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        signal: AbortSignal.timeout(10_000),
      });
      const cookies = resp.headers.getSetCookie?.() ?? [];
      if (cookies.length > 0) {
        this.cookieString = cookies.map(c => c.split(";")[0]).join("; ");
      }
      return this.cookieString;
    } catch (err) {
      this.logger.warn({ err: String(err) }, "12306: cookie fetch failed");
      return null;
    }
  }

  private async queryAndParse(date: string, fromCode: string, toCode: string, params: TrainSearchParams): Promise<Train[]> {
    const cookie = await this.ensureCookie();
    if (!cookie) return [];

    const url = `${API_BASE}/otn/leftTicket/query?leftTicketDTO.train_date=${date}&leftTicketDTO.from_station=${fromCode}&leftTicketDTO.to_station=${toCode}&purpose_codes=ADULT`;
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Cookie: cookie,
        Referer: "https://kyfw.12306.cn/otn/leftTicket/init",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      this.logger.warn({ status: resp.status }, "12306: query returned non-200");
      return [];
    }

    const body = await resp.json() as { data?: { result?: string[]; map?: Record<string, string> }; httpstatus?: number };
    if (!body.data?.result || !body.data?.map) {
      this.logger.warn({ body: JSON.stringify(body).slice(0, 200) }, "12306: unexpected response");
      return [];
    }

    const stationMap = body.data.map;
    return body.data.result
      .map(raw => this.parseTicket(raw, stationMap, params))
      .filter((t): t is Train => t !== null);
  }

  private parseTicket(raw: string, stationMap: Record<string, string>, params: TrainSearchParams): Train | null {
    const values = raw.split("|");
    if (values.length < TICKET_FIELDS.length) return null;

    const get = (field: string): string => {
      const idx = TICKET_FIELDS.indexOf(field);
      return idx >= 0 ? (values[idx] ?? "") : "";
    };

    const trainCode = get("station_train_code");
    if (!trainCode) return null;

    const fromTele = get("from_station_telecode");
    const toTele = get("to_station_telecode");
    const ypInfoNew = get("yp_info_new");

    const price = this.extractBestPrice(ypInfoNew, get("seat_discount_info"), values);

    return {
      trainNo: trainCode,
      trainType: inferTrainType(trainCode),
      departureCity: stationMap[fromTele] ?? params.from,
      arrivalCity: stationMap[toTele] ?? params.to,
      departureTime: get("start_time"),
      arrivalTime: get("arrive_time"),
      price: price.price,
      durationHours: Math.round(parseDuration(get("lishi")) * 10) / 10,
      seatType: price.seatType,
    };
  }

  private extractBestPrice(ypInfoNew: string, _seatDiscount: string, values: string[]): { price: number; seatType: string } {
    const CHUNK = 10;
    let bestPrice = Infinity;
    let bestSeat = "二等座";

    for (let i = 0; i + CHUNK <= ypInfoNew.length; i += CHUNK) {
      const chunk = ypInfoNew.slice(i, i + CHUNK);
      const typeCode = chunk[0];
      if (!typeCode) continue;

      const shortKey = SEAT_SHORT[typeCode];
      if (!shortKey) continue;

      const numIdx = TICKET_FIELDS.indexOf(`${shortKey}_num`);
      const num = numIdx >= 0 ? (values[numIdx] ?? "") : "";
      if (!hasTickets(num)) continue;

      const priceYuan = parseInt(chunk.slice(1, 6), 10) / 10;
      if (priceYuan > 0 && priceYuan < bestPrice) {
        bestPrice = priceYuan;
        bestSeat = SEAT_TYPE_NAMES[typeCode] ?? "二等座";
      }
    }

    return { price: bestPrice === Infinity ? 0 : bestPrice, seatType: bestSeat };
  }

  private async fetchText(url: string): Promise<string> {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) throw new Error(`fetch ${url} returned ${resp.status}`);
    return resp.text();
  }
}
