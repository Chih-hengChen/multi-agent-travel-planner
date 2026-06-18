import { describe, it, expect } from "vitest";
import {
  TravelPlanSchema,
  DayPlanSchema,
  TransitSegmentSchema,
  parsePlanLoose,
  JsonRepairExhaustedError,
} from "../definitions/plan-schema.js";

function validDayPlan(dayIdx = 0, date = "2026-07-01") {
  return {
    dayIdx,
    date,
    morning: {
      attractions: [{
        name: "浅草寺",
        category: "attraction",
        location: { lat: 35.71, lng: 139.79, address: "东京" },
        estimatedDurationMin: 120,
        estimatedCost: 0,
        description: "东京最古老的寺院,雷门灯笼是地标,建议早 9 点前到达避开人群",
        source: "amap",
        rerankScore: 0.92,
      }],
      transitToNext: {
        from: "浅草寺",
        to: "晴空塔",
        mode: "walking",
        durationMin: 15,
        distanceKm: 1.2,
        cost: "¥0",
        costAmount: 0,
        steps: ["沿隅田川"],
        fallbackLevel: 0,
      },
    },
    afternoon: {
      attractions: [{
        name: "晴空塔",
        category: "attraction",
        location: { lat: 35.71, lng: 139.81, address: "东京" },
        estimatedDurationMin: 180,
        estimatedCost: 2100,
        description: "634 米世界最高塔,展望台看东京全景,建议买联票",
        source: "xhs",
        rerankScore: 0.88,
      }],
    },
    dining: [
      { meal: "breakfast", isLocalSpecialty: false },
      {
        meal: "lunch",
        restaurant: {
          name: "浅草今半",
          category: "restaurant",
          location: { lat: 35.71, lng: 139.79, address: "东京" },
          estimatedDurationMin: 60,
          estimatedCost: 2500,
          description: "百年寿喜烧老店,黑毛和牛入口即化,午餐套餐性价比高",
          source: "xhs",
          rerankScore: 0.85,
        },
        isLocalSpecialty: true,
      },
      { meal: "dinner", isLocalSpecialty: false, alternatives: ["酒店内"] },
    ],
    transitTips: ["浅草→晴空塔步行 15 分钟"],
  };
}

function validPlan() {
  return {
    destination: "东京",
    startDate: "2026-07-01",
    endDate: "2026-07-02",
    travelers: 2,
    dayPlans: [validDayPlan()],
    budgetBreakdown: {
      totalCost: 4600,
      byCategory: { transport: 0, accommodation: 0, food: 2500, attractions: 2100, other: 0 },
      budgetLimit: 15000,
      isWithinBudget: true,
      variance: -10400,
    },
    warnings: [],
  };
}

describe("TravelPlanSchema", () => {
  it("accepts valid plan", () => {
    const parsed = TravelPlanSchema.safeParse(validPlan());
    expect(parsed.success).toBe(true);
  });

  it("rejects plan with wrong date format", () => {
    const p = validPlan();
    p.startDate = "07/01/2026";
    expect(TravelPlanSchema.safeParse(p).success).toBe(false);
  });

  it("rejects dayPlan with < 3 dining entries", () => {
    const p = validPlan();
    p.dayPlans[0].dining = [{ meal: "breakfast", isLocalSpecialty: false }];
    expect(TravelPlanSchema.safeParse(p).success).toBe(false);
  });

  it("rejects activity description < 20 chars", () => {
    const p = validPlan();
    p.dayPlans[0].morning!.attractions[0].description = "too short";
    expect(TravelPlanSchema.safeParse(p).success).toBe(false);
  });

  it("rejects rerankScore > 1", () => {
    const p = validPlan();
    p.dayPlans[0].morning!.attractions[0].rerankScore = 1.5;
    expect(TravelPlanSchema.safeParse(p).success).toBe(false);
  });
});

describe("TransitSegmentSchema", () => {
  it("rejects fallbackLevel outside 0|1|2", () => {
    const t = {
      from: "A", to: "B", mode: "walking",
      durationMin: 10, distanceKm: 1, cost: "¥0", costAmount: 0,
      steps: [], fallbackLevel: 3,
    };
    expect(TransitSegmentSchema.safeParse(t).success).toBe(false);
  });

  it("accepts fallbackLevel = 0", () => {
    const t = {
      from: "A", to: "B", mode: "walking",
      durationMin: 10, distanceKm: 1, cost: "¥0", costAmount: 0,
      steps: [], fallbackLevel: 0,
    };
    expect(TransitSegmentSchema.safeParse(t).success).toBe(true);
  });
});

describe("DayPlanSchema", () => {
  it("requires dayIdx >= 0", () => {
    const d = validDayPlan(-1);
    expect(DayPlanSchema.safeParse(d).success).toBe(false);
  });

  it("requires date YYYY-MM-DD", () => {
    const d = validDayPlan(0, "2026/07/01");
    expect(DayPlanSchema.safeParse(d).success).toBe(false);
  });
});

describe("parsePlanLoose", () => {
  it("parses valid JSON directly", () => {
    const raw = JSON.stringify(validPlan());
    const plan = parsePlanLoose(raw);
    expect(plan.destination).toBe("东京");
  });

  it("extracts JSON from surrounding text", () => {
    const raw = `Here's the plan: ${JSON.stringify(validPlan())} hope you like it`;
    const plan = parsePlanLoose(raw);
    expect(plan.destination).toBe("东京");
  });

  it("repairs trailing comma", () => {
    const raw = JSON.stringify(validPlan(), null, 2).replace(/(\d)\n/g, "$1,\n");
    expect(() => parsePlanLoose(raw)).not.toThrow();
  });

  it("repairs single quotes around string values", () => {
    const raw = JSON.stringify(validPlan()).replace(/"东京"/g, "'东京'");
    const plan = parsePlanLoose(raw);
    expect(plan.destination).toBe("东京");
  });

  it("repairs missing closing brace", () => {
    const valid = JSON.stringify(validPlan());
    const truncated = valid.slice(0, -1);
    expect(() => parsePlanLoose(truncated)).not.toThrow();
  });

  it("throws JsonRepairExhaustedError when no JSON object found", () => {
    expect(() => parsePlanLoose("just plain text")).toThrow(JsonRepairExhaustedError);
  });

  it("throws on empty input", () => {
    expect(() => parsePlanLoose("")).toThrow(JsonRepairExhaustedError);
    expect(() => parsePlanLoose("   ")).toThrow(JsonRepairExhaustedError);
  });

  it("throws JsonRepairExhaustedError when schema validation fails after repair", () => {
    const raw = JSON.stringify({ foo: "bar" });
    expect(() => parsePlanLoose(raw)).toThrow(JsonRepairExhaustedError);
  });

  it("preserves last error in thrown exception", () => {
    try {
      parsePlanLoose('{"foo": "bar"}');
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(JsonRepairExhaustedError);
      expect((err as JsonRepairExhaustedError).lastError).toBeDefined();
    }
  });
});
