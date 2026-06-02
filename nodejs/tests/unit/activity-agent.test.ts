import { describe, it, expect } from "vitest";
import { ActivityAgent } from "../../src/agents/activity-agent.js";

describe("ActivityAgent.getTravelDays", () => {
  it("returns 4 days for 5-day trip", () => {
    const days = ActivityAgent.getTravelDays("2026-06-01", "2026-06-05");
    expect(days).toEqual(["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04"]);
  });

  it("returns 1 day for same-day trip", () => {
    const days = ActivityAgent.getTravelDays("2026-06-01", "2026-06-01");
    expect(days).toEqual(["2026-06-01"]);
  });

  it("returns 1 day for overnight trip", () => {
    const days = ActivityAgent.getTravelDays("2026-06-01", "2026-06-02");
    expect(days).toEqual(["2026-06-01"]);
  });

  it("returns empty or default for invalid input", () => {
    const days = ActivityAgent.getTravelDays("bad", "input");
    expect(Array.isArray(days)).toBe(true);
  });
});
