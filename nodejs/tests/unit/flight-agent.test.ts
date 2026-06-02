import { describe, it, expect } from "vitest";
import { FlightAgent } from "../../src/agents/flight-agent.js";
import type { Flight, Train } from "../../src/types/index.js";

const makeFlight = (overrides: Partial<Flight> = {}): Flight => ({
  airline: "测试航空", flightNo: "TEST001", departureCity: "上海", arrivalCity: "北京",
  departureTime: "08:00", arrivalTime: "10:30", price: 800, durationHours: 2.5, stops: 0,
  cabinClass: "economy", ...overrides,
});

const makeTrain = (overrides: Partial<Train> = {}): Train => ({
  trainNo: "G100", trainType: "高铁", departureCity: "上海", arrivalCity: "北京",
  departureTime: "07:00", arrivalTime: "11:30", price: 553, durationHours: 4.5,
  seatType: "二等座", ...overrides,
});

describe("FlightAgent.bestFlight", () => {
  it("returns null for empty array", () => {
    expect(FlightAgent.bestFlight([], 3000)).toBeNull();
  });

  it("returns single flight", () => {
    const f = makeFlight();
    expect(FlightAgent.bestFlight([f], 3000)).toBe(f);
  });

  it("prefers flight within budget share", () => {
    const within = makeFlight({ price: 400, flightNo: "W001" });
    const over = makeFlight({ price: 4000, flightNo: "O001" });
    const result = FlightAgent.bestFlight([over, within], 500);
    expect(result).toBe(within);
  });

  it("prefers shorter duration when both within budget", () => {
    const fast = makeFlight({ price: 800, durationHours: 2.0, flightNo: "F001" });
    const slow = makeFlight({ price: 800, durationHours: 5.0, flightNo: "S001" });
    const result = FlightAgent.bestFlight([slow, fast], 3000);
    expect(result).toBe(fast);
  });

  it("prefers direct flight over connecting", () => {
    const direct = makeFlight({ price: 800, durationHours: 2.5, stops: 0, flightNo: "D001" });
    const connecting = makeFlight({ price: 800, durationHours: 2.5, stops: 2, flightNo: "C001" });
    const result = FlightAgent.bestFlight([connecting, direct], 3000);
    expect(result).toBe(direct);
  });

  it("综合价格+时长+经停选择最优", () => {
    const cheap = makeFlight({ price: 500, durationHours: 3.0, stops: 1, flightNo: "CH001" });
    const optimal = makeFlight({ price: 700, durationHours: 2.0, stops: 0, flightNo: "OP001" });
    const result = FlightAgent.bestFlight([cheap, optimal], 3000);
    expect(result).toBe(optimal);
  });
});

describe("FlightAgent.bestTrain", () => {
  it("returns null for empty array", () => {
    expect(FlightAgent.bestTrain([], 2000)).toBeNull();
  });

  it("returns single train", () => {
    const t = makeTrain();
    expect(FlightAgent.bestTrain([t], 2000)).toBe(t);
  });

  it("gives G-series bonus", () => {
    const gTrain = makeTrain({ trainNo: "G100", trainType: "高铁", price: 553, durationHours: 4.5 });
    const dTrain = makeTrain({ trainNo: "D100", trainType: "动车", price: 553, durationHours: 4.5 });
    const result = FlightAgent.bestTrain([dTrain, gTrain], 2000);
    expect(result).toBe(gTrain);
  });

  it("prefers train within budget share", () => {
    const within = makeTrain({ price: 300, trainNo: "W001" });
    const over = makeTrain({ price: 2000, trainNo: "O001" });
    const result = FlightAgent.bestTrain([over, within], 500);
    expect(result).toBe(within);
  });

  it("综合价格+时长+G系列选择最优", () => {
    const cheap = makeTrain({ trainNo: "D100", trainType: "动车", price: 450, durationHours: 8.0 });
    const optimal = makeTrain({ trainNo: "G200", trainType: "高铁", price: 553, durationHours: 4.5 });
    const result = FlightAgent.bestTrain([cheap, optimal], 1000);
    expect(result).toBe(optimal);
  });
});
