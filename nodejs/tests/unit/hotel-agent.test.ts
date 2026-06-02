import { describe, it, expect } from "vitest";
import { HotelAgent } from "../../src/agents/hotel-agent.js";
import { TravelStyle, type Hotel, type UserPreferences } from "../../src/types/index.js";

const makeHotel = (overrides: Partial<Hotel> = {}): Hotel => ({
  name: "测试酒店", city: "北京", address: "测试地址",
  starRating: 3.5, userRating: 8.0, pricePerNight: 400,
  amenities: ["WiFi"], distanceToCenterKm: 2.0, ...overrides,
});

const makePref = (overrides: Partial<UserPreferences> = {}): UserPreferences => ({
  budget: 10000, travelStyle: TravelStyle.COMFORT, departureCity: "北京",
  startDate: "2026-06-01", endDate: "2026-06-05", numTravelers: 1,
  interests: [], dietaryRestrictions: [], accessibilityNeeds: [], notes: "",
  transportPreference: "no_preference", departureTime: "flexible", budgetStrictness: "strict",
  accommodationType: "any", preferredHotelBrands: [], localTransitMode: "mixed",
  diningPreference: "mixed", ...overrides,
});

describe("HotelAgent.calcNights", () => {
  it("calculates 4 nights for 5-day trip", () => {
    expect(HotelAgent.calcNights("2026-06-01", "2026-06-05")).toBe(4);
  });

  it("returns 1 for same day", () => {
    expect(HotelAgent.calcNights("2026-06-01", "2026-06-01")).toBe(1);
  });

  it("returns 1 for reversed dates (clamped)", () => {
    expect(HotelAgent.calcNights("2026-06-05", "2026-06-01")).toBe(1);
  });

  it("handles invalid input gracefully", () => {
    const result = HotelAgent.calcNights("invalid", "2026-06-05");
    expect(typeof result === "number").toBe(true);
  });
});

describe("HotelAgent.bestHotel", () => {
  it("returns null for empty array", () => {
    expect(HotelAgent.bestHotel([], 500, makePref())).toBeNull();
  });

  it("returns single hotel", () => {
    const h = makeHotel();
    expect(HotelAgent.bestHotel([h], 500, makePref())).toBe(h);
  });

  it("gives price bonus for within budget", () => {
    const within = makeHotel({ name: "平价酒店", pricePerNight: 300 });
    const over = makeHotel({ name: "昂贵酒店", pricePerNight: 800 });
    const result = HotelAgent.bestHotel([over, within], 500, makePref());
    expect(result).toBe(within);
  });

  it("prefers star rating matching luxury style", () => {
    const three = makeHotel({ name: "三星", starRating: 3.0 });
    const five = makeHotel({ name: "五星", starRating: 5.0 });
    const pref = makePref({ travelStyle: TravelStyle.LUXURY });
    const result = HotelAgent.bestHotel([three, five], 2000, pref);
    expect(result).toBe(five);
  });

  it("gives brand bonus for matching brand", () => {
    const branded = makeHotel({ name: "Marriott 北京", pricePerNight: 400 });
    const unbranded = makeHotel({ name: "普通酒店", pricePerNight: 400 });
    const pref = makePref({ preferredHotelBrands: ["Marriott"] });
    const result = HotelAgent.bestHotel([unbranded, branded], 500, pref);
    expect(result).toBe(branded);
  });

  it("prefers hotel closer to center", () => {
    const central = makeHotel({ name: "市中心", distanceToCenterKm: 0.5, pricePerNight: 400, starRating: 3.5, userRating: 8.0 });
    const far = makeHotel({ name: "远郊", distanceToCenterKm: 8.0, pricePerNight: 400, starRating: 3.5, userRating: 8.0 });
    const result = HotelAgent.bestHotel([far, central], 500, makePref());
    expect(result).toBe(central);
  });
});
