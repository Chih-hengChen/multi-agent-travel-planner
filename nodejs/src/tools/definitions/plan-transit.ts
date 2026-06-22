import type { AgentState, TransitSegment } from "../../runtime/state.js";
import { UNKNOWN_COST_AMOUNT } from "../../runtime/state.js";
import type { ToolResultLike } from "../../runtime/apply-tool-effects.js";

export interface PlanTransitInput {
  from: string;
  to: string;
  dayIdx: number;
  departAt?: string;
  mode?: "transit" | "walking" | "driving" | "rideshare";
}

export interface LatLng {
  lat: number;
  lng: number;
}

export interface AmapDirection {
  durationSec: number;
  distanceMeters: number;
  cost: string | null;
  steps: string[];
}

export interface AmapClient {
  geocode(name: string, city?: string): Promise<LatLng | null>;
  directionTransit(start: LatLng, end: LatLng): Promise<AmapDirection | null>;
}

export interface PlanTransitResult {
  dayIdx: number;
  transit: TransitSegment;
}

function fuzzyMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.includes(b) || b.includes(a) || a.replace(/[（）()\[\]【】\s]/g, "").includes(b.replace(/[（）()\[\]【】\s]/g, ""));
}

function findCoordsByName(name: string | undefined, state: AgentState): LatLng | undefined {
  if (!name) return undefined;
  interface HasCoords { name?: string; geoLocation?: { lat: number; lon: number } }

  for (const a of state.candidateAttractions ?? []) {
    const act = a as unknown as HasCoords;
    if (fuzzyMatch(act.name, name) && act.geoLocation) {
      return { lat: act.geoLocation.lat, lng: act.geoLocation.lon };
    }
  }
  for (const list of Object.values(state.planningRestaurants ?? {})) {
    for (const r of list ?? []) {
      const rest = r as unknown as HasCoords;
      if (fuzzyMatch(rest.name, name) && rest.geoLocation) {
        return { lat: rest.geoLocation.lat, lng: rest.geoLocation.lon };
      }
    }
  }
  for (const h of state.candidateHotels ?? []) {
    const hotel = h as unknown as { name?: string; geoLocation?: { lat: number; lon: number } };
    if (fuzzyMatch(hotel.name, name)) {
      if (hotel.geoLocation) return { lat: hotel.geoLocation.lat, lng: hotel.geoLocation.lon };
      return undefined;
    }
  }
  return undefined;
}

function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function haversineEstimate(from: string, to: string, start: LatLng | null, end: LatLng | null, mode: NonNullable<PlanTransitInput["mode"]>): TransitSegment {
  const distanceKm = start && end ? haversineKm(start, end) : 2.0;
  const speedKmh = mode === "walking" ? 5 : mode === "driving" ? 30 : mode === "rideshare" ? 35 : 20;
  const durationMin = Math.max(5, Math.round((distanceKm / speedKmh) * 60));
  const costPerKm = mode === "walking" ? 0 : mode === "transit" ? 0.4 : mode === "rideshare" ? 2.5 : 2.0;
  const costAmount = Math.round(distanceKm * costPerKm);
  return {
    from,
    to,
    mode,
    durationMin,
    distanceKm: Math.round(distanceKm * 10) / 10,
    cost: costAmount === 0 ? "¥0" : `≈¥${costAmount}`,
    costAmount,
    steps: [`(估算)直线 ${distanceKm.toFixed(1)}km / ${mode} ${speedKmh}km/h`],
    fallbackLevel: 1,
  };
}

export async function executePlanTransit(
  input: PlanTransitInput,
  state: AgentState,
  amap: AmapClient,
): Promise<ToolResultLike> {
  const mode = input.mode ?? "transit";

  const startFromState = findCoordsByName(input.from, state);
  const endFromState = findCoordsByName(input.to, state);

  let start: LatLng | null = startFromState ?? null;
  let end: LatLng | null = endFromState ?? null;

  const city = state.preferences?.preferredDestination;
  if (!start) start = await amap.geocode(input.from, city);
  if (!end) end = await amap.geocode(input.to, city);

  if (!start || !end) {
    const transit = haversineEstimate(input.from, input.to, start, end, mode);
    return {
      toolName: "plan_transit",
      success: true,
      data: { dayIdx: input.dayIdx ?? 0, transit } satisfies PlanTransitResult,
      fallbackLevel: 2,
    };
  }

  let direction: AmapDirection | null = null;
  try {
    direction = await amap.directionTransit(start, end);
  } catch {
    direction = null;
  }

  if (!direction) {
    const transit = haversineEstimate(input.from, input.to, start, end, mode);
    return {
      toolName: "plan_transit",
      success: true,
      data: { dayIdx: input.dayIdx, transit } satisfies PlanTransitResult,
      fallbackLevel: 1,
    };
  }

  const costAmount = parseCost(direction.cost);
  const transit: TransitSegment = {
    from: input.from,
    to: input.to,
    mode,
    durationMin: Math.round(direction.durationSec / 60),
    distanceKm: Math.round((direction.distanceMeters / 1000) * 10) / 10,
    cost: direction.cost ?? (costAmount >= 0 ? `¥${costAmount}` : "未知"),
    costAmount: costAmount >= 0 ? costAmount : UNKNOWN_COST_AMOUNT,
    steps: direction.steps,
    fallbackLevel: 0,
  };

  return {
    toolName: "plan_transit",
    success: true,
    data: { dayIdx: input.dayIdx, transit } satisfies PlanTransitResult,
    fallbackLevel: 0,
  };
}

function parseCost(cost: string | null): number {
  if (!cost) return UNKNOWN_COST_AMOUNT;
  const m = cost.match(/(\d+(?:\.\d+)?)/);
  if (!m) return UNKNOWN_COST_AMOUNT;
  return parseFloat(m[1]);
}
