import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { settings } from "../config/settings.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cityAdcodeMap: Record<string, string> = JSON.parse(
  readFileSync(resolve(__dirname, "amap-city-adcode.json"), "utf-8")
);

export interface WeatherLive {
  province: string;
  city: string;
  weather: string;
  temperature: number;
  winddirection: string;
  windpower: string;
  humidity: string;
  reporttime: string;
}

export interface WeatherForecastDay {
  date: string;
  dayweather: string;
  nightweather: string;
  daytemp: number;
  nighttemp: number;
  daywind: string;
  nightwind: string;
  daypower: string;
  nightpower: string;
}

export interface WeatherForecast {
  city: string;
  reporttime: string;
  casts: WeatherForecastDay[];
}

export interface WeatherResult {
  city: string;
  live?: WeatherLive;
  forecast?: WeatherForecast;
}

export class AmapWeatherSource {
  async getLiveWeather(city: string): Promise<WeatherLive | null> {
    const adcode = this.resolveAdcode(city);
    if (!adcode) return null;

    try {
      const url = "https://restapi.amap.com/v3/weather/weatherInfo"
        + "?key=" + settings.AMAP_API_KEY
        + "&city=" + adcode
        + "&extensions=base"
        + "&output=JSON";

      const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!resp.ok) return null;

      const data = await resp.json() as {
        status: string;
        lives?: Array<{
          province: string; city: string; weather: string;
          temperature: string; winddirection: string; windpower: string;
          humidity: string; reporttime: string;
        }>;
      };

      if (data.status !== "1" || !data.lives?.length) return null;

      const l = data.lives[0];
      return {
        province: l.province,
        city: l.city,
        weather: l.weather,
        temperature: Number(l.temperature),
        winddirection: l.winddirection,
        windpower: l.windpower,
        humidity: l.humidity,
        reporttime: l.reporttime,
      };
    } catch {
      return null;
    }
  }

  async getForecast(city: string): Promise<WeatherForecast | null> {
    const adcode = this.resolveAdcode(city);
    if (!adcode) return null;

    try {
      const url = "https://restapi.amap.com/v3/weather/weatherInfo"
        + "?key=" + settings.AMAP_API_KEY
        + "&city=" + adcode
        + "&extensions=all"
        + "&output=JSON";

      const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!resp.ok) return null;

      const data = await resp.json() as {
        status: string;
        forecasts?: Array<{
          city: string; casts?: Array<{
            date: string; dayweather: string; nightweather: string;
            daytemp: string; nighttemp: string;
            daywind: string; nightwind: string;
            daypower: string; nightpower: string;
          }>;
        }>;
      };

      if (data.status !== "1" || !data.forecasts?.length) return null;

      const f = data.forecasts[0];
      return {
        city: f.city,
        reporttime: "",
        casts: (f.casts ?? []).map((c) => ({
          date: c.date,
          dayweather: c.dayweather,
          nightweather: c.nightweather,
          daytemp: Number(c.daytemp),
          nighttemp: Number(c.nighttemp),
          daywind: c.daywind,
          nightwind: c.nightwind,
          daypower: c.daypower,
          nightpower: c.nightpower,
        })),
      };
    } catch {
      return null;
    }
  }

  async getFullWeather(city: string): Promise<WeatherResult | null> {
    const [live, forecast] = await Promise.all([
      this.getLiveWeather(city),
      this.getForecast(city),
    ]);
    if (!live && !forecast) return null;
    return { city, live: live ?? undefined, forecast: forecast ?? undefined };
  }

  private resolveAdcode(city: string): string | null {
    const adcode = cityAdcodeMap[city];
    if (adcode) return adcode;
    for (const [name, code] of Object.entries(cityAdcodeMap)) {
      if (city.includes(name) || name.includes(city)) return code;
    }
    return null;
  }
}
