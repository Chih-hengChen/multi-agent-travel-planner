import { TravelStyle, type UserPreferences } from "../../src/types/index.js";

export function budgetWeekendPrefs(): UserPreferences {
  return {
    budget: 1500,
    travelStyle: TravelStyle.BUDGET,
    departureCity: "上海",
    startDate: "2026-06-05",
    endDate: "2026-06-07",
    numTravelers: 1,
    interests: ["故宫", "升旗"],
    dietaryRestrictions: [],
    accessibilityNeeds: [],
    notes: "越省越好",
    transportPreference: "no_preference",
    departureTime: "evening",
    budgetStrictness: "strict",
    accommodationType: "any",
    preferredHotelBrands: [],
    localTransitMode: "mixed",
    diningPreference: "mixed",
  };
}

export function businessLuxuryPrefs(): UserPreferences {
  return {
    budget: 8000,
    travelStyle: TravelStyle.LUXURY,
    departureCity: "广州",
    startDate: "2026-07-05",
    endDate: "2026-07-08",
    numTravelers: 1,
    interests: ["food", "relaxation"],
    dietaryRestrictions: [],
    accessibilityNeeds: [],
    notes: "不要太累",
    transportPreference: "no_preference",
    departureTime: "flexible",
    budgetStrictness: "luxury",
    accommodationType: "hotel",
    preferredStarRating: 5,
    preferredHotelBrands: [],
    localTransitMode: "taxi",
    diningPreference: "local_specialties",
  };
}

export function railBnbPrefs(): UserPreferences {
  return {
    budget: 3000,
    travelStyle: TravelStyle.CULTURAL,
    departureCity: "武汉",
    startDate: "2026-07-10",
    endDate: "2026-07-13",
    numTravelers: 1,
    interests: ["陶瓷文化", "集市"],
    dietaryRestrictions: [],
    accessibilityNeeds: [],
    notes: "",
    transportPreference: "high_speed_rail",
    departureTime: "morning",
    budgetStrictness: "flexible",
    accommodationType: "homestay",
    preferredHotelBrands: [],
    localTransitMode: "mixed",
    diningPreference: "local_specialties",
  };
}

export function noTransitPrefs(): UserPreferences {
  return {
    budget: 2000,
    travelStyle: TravelStyle.RELAXATION,
    departureCity: "大理",
    startDate: "2026-08-01",
    endDate: "2026-08-03",
    numTravelers: 1,
    interests: ["温泉"],
    dietaryRestrictions: [],
    accessibilityNeeds: [],
    notes: "",
    transportPreference: "no_preference",
    departureTime: "flexible",
    budgetStrictness: "strict",
    accommodationType: "any",
    preferredHotelBrands: [],
    localTransitMode: "taxi",
    diningPreference: "local_specialties",
  };
}
