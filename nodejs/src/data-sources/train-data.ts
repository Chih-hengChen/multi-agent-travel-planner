import type { Train } from "../types/index.js";
import type { FlightSearchParams, HotelSearchParams, AttractionSearchParams, TrainSearchParams, TravelDataSource } from "./types.js";

interface TrainRoute {
  from: string;
  to: string;
  gPrice: number;
  dPrice: number;
  kPrice: number;
  gDuration: number;
  dDuration: number;
}

const ROUTES: TrainRoute[] = [
  { from: "北京", to: "上海", gPrice: 553, dPrice: 410, kPrice: 178, gDuration: 4.5, dDuration: 10 },
  { from: "上海", to: "北京", gPrice: 553, dPrice: 410, kPrice: 178, gDuration: 4.5, dDuration: 10 },
  { from: "北京", to: "广州", gPrice: 862, dPrice: 650, kPrice: 251, gDuration: 8, dDuration: 15 },
  { from: "广州", to: "北京", gPrice: 862, dPrice: 650, kPrice: 251, gDuration: 8, dDuration: 15 },
  { from: "北京", to: "武汉", gPrice: 523, dPrice: 380, kPrice: 155, gDuration: 4.2, dDuration: 9 },
  { from: "武汉", to: "北京", gPrice: 523, dPrice: 380, kPrice: 155, gDuration: 4.2, dDuration: 9 },
  { from: "北京", to: "西安", gPrice: 515, dPrice: 370, kPrice: 149, gDuration: 4.5, dDuration: 11 },
  { from: "西安", to: "北京", gPrice: 515, dPrice: 370, kPrice: 149, gDuration: 4.5, dDuration: 11 },
  { from: "北京", to: "成都", gPrice: 778, dPrice: 560, kPrice: 215, gDuration: 7.5, dDuration: 15 },
  { from: "成都", to: "北京", gPrice: 778, dPrice: 560, kPrice: 215, gDuration: 7.5, dDuration: 15 },
  { from: "上海", to: "杭州", gPrice: 73, dPrice: 55, kPrice: 28, gDuration: 0.9, dDuration: 2 },
  { from: "杭州", to: "上海", gPrice: 73, dPrice: 55, kPrice: 28, gDuration: 0.9, dDuration: 2 },
  { from: "上海", to: "南京", gPrice: 134, dPrice: 95, kPrice: 47, gDuration: 1.2, dDuration: 3.5 },
  { from: "南京", to: "上海", gPrice: 134, dPrice: 95, kPrice: 47, gDuration: 1.2, dDuration: 3.5 },
  { from: "广州", to: "深圳", gPrice: 75, dPrice: 55, kPrice: 24, gDuration: 0.5, dDuration: 1.5 },
  { from: "深圳", to: "广州", gPrice: 75, dPrice: 55, kPrice: 24, gDuration: 0.5, dDuration: 1.5 },
  { from: "上海", to: "武汉", gPrice: 393, dPrice: 280, kPrice: 112, gDuration: 4, dDuration: 8 },
  { from: "武汉", to: "上海", gPrice: 393, dPrice: 280, kPrice: 112, gDuration: 4, dDuration: 8 },
  { from: "成都", to: "重庆", gPrice: 154, dPrice: 110, kPrice: 48, gDuration: 1.5, dDuration: 3 },
  { from: "重庆", to: "成都", gPrice: 154, dPrice: 110, kPrice: 48, gDuration: 1.5, dDuration: 3 },
  { from: "北京", to: "天津", gPrice: 55, dPrice: 40, kPrice: 19, gDuration: 0.5, dDuration: 1.5 },
  { from: "天津", to: "北京", gPrice: 55, dPrice: 40, kPrice: 19, gDuration: 0.5, dDuration: 1.5 },
  { from: "武汉", to: "长沙", gPrice: 165, dPrice: 120, kPrice: 54, gDuration: 1.5, dDuration: 3.5 },
  { from: "长沙", to: "武汉", gPrice: 165, dPrice: 120, kPrice: 54, gDuration: 1.5, dDuration: 3.5 },
  { from: "广州", to: "长沙", gPrice: 314, dPrice: 230, kPrice: 99, gDuration: 2.5, dDuration: 7 },
  { from: "长沙", to: "广州", gPrice: 314, dPrice: 230, kPrice: 99, gDuration: 2.5, dDuration: 7 },
  { from: "上海", to: "厦门", gPrice: 430, dPrice: 310, kPrice: 130, gDuration: 5, dDuration: 12 },
  { from: "厦门", to: "上海", gPrice: 430, dPrice: 310, kPrice: 130, gDuration: 5, dDuration: 12 },
  { from: "北京", to: "哈尔滨", gPrice: 541, dPrice: 390, kPrice: 155, gDuration: 5, dDuration: 12 },
  { from: "哈尔滨", to: "北京", gPrice: 541, dPrice: 390, kPrice: 155, gDuration: 5, dDuration: 12 },
];

function findRoute(from: string, to: string): TrainRoute | undefined {
  return ROUTES.find((r) => r.from === from && r.to === to);
}

export function estimateTrainPrice(from: string, to: string): Train[] {
  const route = findRoute(from, to);
  if (!route) return [];

  return [
    {
      trainNo: `G${1000 + Math.floor(Math.random() * 8000)}`,
      trainType: "高铁",
      departureCity: from,
      arrivalCity: to,
      departureTime: "07:00",
      arrivalTime: `${7 + Math.floor(route.gDuration)}:${String(Math.round((route.gDuration % 1) * 60)).padStart(2, "0")}`,
      price: route.gPrice,
      durationHours: route.gDuration,
      seatType: "二等座",
    },
    {
      trainNo: `D${2000 + Math.floor(Math.random() * 6000)}`,
      trainType: "动车",
      departureCity: from,
      arrivalCity: to,
      departureTime: "08:30",
      arrivalTime: `${8 + Math.floor(route.dDuration)}:${String(Math.round((route.dDuration % 1) * 60)).padStart(2, "0")}`,
      price: route.dPrice,
      durationHours: route.dDuration,
      seatType: "二等座",
    },
  ];
}

export class TrainDataSource implements TravelDataSource {
  async searchFlights(_params: FlightSearchParams): Promise<never[]> {
    return [];
  }

  async searchHotels(_params: HotelSearchParams): Promise<never[]> {
    return [];
  }

  async searchAttractions(_params: AttractionSearchParams): Promise<never[]> {
    return [];
  }

  async searchTrains(params: TrainSearchParams): Promise<Train[]> {
    return estimateTrainPrice(params.from, params.to);
  }
}
