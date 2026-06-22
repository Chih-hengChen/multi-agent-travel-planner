import fs from "node:fs";
import path from "node:path";
import type { Hotel } from "../types/index.js";

const CACHE_DIR = path.resolve("data", "cache", "hotels");
const CACHE_TTL_MS = 60 * 60 * 1000;

function ensureDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function cacheKey(city: string, checkIn: string, checkOut: string, adults: number, maxPrice?: number): string {
  const slug = `${city}_${checkIn}_${checkOut}_${adults}_${maxPrice ?? "any"}`;
  return slug.replace(/[\/\\:*?"<>|]/g, "_");
}

export function loadCachedHotels(city: string, checkIn: string, checkOut: string, adults: number, maxPrice?: number): Hotel[] | null {
  ensureDir();
  const key = cacheKey(city, checkIn, checkOut, adults, maxPrice);
  const file = path.join(CACHE_DIR, `${key}.json`);
  if (!fs.existsSync(file)) return null;

  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (Date.now() - data.cachedAt > CACHE_TTL_MS) {
      fs.unlinkSync(file);
      return null;
    }
    return data.hotels as Hotel[];
  } catch {
    return null;
  }
}

export function saveCachedHotels(city: string, checkIn: string, checkOut: string, adults: number, maxPrice: number | undefined, hotels: Hotel[]) {
  ensureDir();
  const key = cacheKey(city, checkIn, checkOut, adults, maxPrice);
  const file = path.join(CACHE_DIR, `${key}.json`);
  fs.writeFileSync(file, JSON.stringify({ cachedAt: Date.now(), hotels }), "utf-8");
}
