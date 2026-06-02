import type { Flight, Train, Hotel, Activity } from "../../src/types/index.js";

// ─── Scenario 1.1: Shanghai → Beijing (budget weekend) ───

export const SHANGHAI_BEIJING_FLIGHTS: Flight[] = [
  { airline: "春秋航空", flightNo: "9C8801", departureCity: "上海", arrivalCity: "北京", departureTime: "22:00", arrivalTime: "00:30", price: 400, durationHours: 2.5, stops: 0, cabinClass: "economy" },
  { airline: "东方航空", flightNo: "MU5101", departureCity: "上海", arrivalCity: "北京", departureTime: "07:30", arrivalTime: "10:00", price: 800, durationHours: 2.5, stops: 0, cabinClass: "economy" },
  { airline: "国航", flightNo: "CA1502", departureCity: "上海", arrivalCity: "北京", departureTime: "09:00", arrivalTime: "11:30", price: 950, durationHours: 2.5, stops: 0, cabinClass: "economy" },
  { airline: "海航", flightNo: "HU7606", departureCity: "上海", arrivalCity: "北京", departureTime: "14:00", arrivalTime: "18:00", price: 1200, durationHours: 4.0, stops: 1, cabinClass: "economy" },
];

export const SHANGHAI_BEIJING_RETURN_FLIGHTS: Flight[] = [
  { airline: "春秋航空", flightNo: "9C8802", departureCity: "北京", arrivalCity: "上海", departureTime: "21:00", arrivalTime: "23:30", price: 420, durationHours: 2.5, stops: 0, cabinClass: "economy" },
  { airline: "东方航空", flightNo: "MU5102", departureCity: "北京", arrivalCity: "上海", departureTime: "08:00", arrivalTime: "10:30", price: 780, durationHours: 2.5, stops: 0, cabinClass: "economy" },
  { airline: "国航", flightNo: "CA1501", departureCity: "北京", arrivalCity: "上海", departureTime: "10:00", arrivalTime: "12:30", price: 900, durationHours: 2.5, stops: 0, cabinClass: "economy" },
  { airline: "海航", flightNo: "HU7605", departureCity: "北京", arrivalCity: "上海", departureTime: "15:00", arrivalTime: "19:00", price: 1100, durationHours: 4.0, stops: 1, cabinClass: "economy" },
];

export const SHANGHAI_BEIJING_TRAINS: Train[] = [
  { trainNo: "G2", trainType: "高铁", departureCity: "上海", arrivalCity: "北京", departureTime: "07:00", arrivalTime: "11:36", price: 553, durationHours: 4.6, seatType: "二等座" },
  { trainNo: "G6", trainType: "高铁", departureCity: "上海", arrivalCity: "北京", departureTime: "09:00", arrivalTime: "13:28", price: 580, durationHours: 4.5, seatType: "二等座" },
  { trainNo: "G14", trainType: "高铁", departureCity: "上海", arrivalCity: "北京", departureTime: "14:00", arrivalTime: "18:28", price: 600, durationHours: 4.5, seatType: "二等座" },
  { trainNo: "D702", trainType: "动车", departureCity: "上海", arrivalCity: "北京", departureTime: "20:00", arrivalTime: "06:48", price: 350, durationHours: 10.8, seatType: "二等座" },
];

export const SHANGHAI_BEIJING_RETURN_TRAINS: Train[] = [
  { trainNo: "G1", trainType: "高铁", departureCity: "北京", arrivalCity: "上海", departureTime: "07:00", arrivalTime: "11:36", price: 553, durationHours: 4.6, seatType: "二等座" },
  { trainNo: "G5", trainType: "高铁", departureCity: "北京", arrivalCity: "上海", departureTime: "09:00", arrivalTime: "13:28", price: 580, durationHours: 4.5, seatType: "二等座" },
  { trainNo: "G15", trainType: "高铁", departureCity: "北京", arrivalCity: "上海", departureTime: "14:00", arrivalTime: "18:28", price: 600, durationHours: 4.5, seatType: "二等座" },
  { trainNo: "D701", trainType: "动车", departureCity: "北京", arrivalCity: "上海", departureTime: "20:00", arrivalTime: "06:48", price: 350, durationHours: 10.8, seatType: "二等座" },
];

export const BEIJING_BUDGET_HOTELS: Hotel[] = [
  { name: "前门青旅", city: "北京", address: "东城区前门大街", starRating: 2.0, userRating: 7.5, pricePerNight: 120, amenities: ["WiFi", "自助厨房"], distanceToCenterKm: 1.0 },
  { name: "天安门太空舱酒店", city: "北京", address: "东城区王府井", starRating: 2.5, userRating: 7.0, pricePerNight: 150, amenities: ["WiFi", "空调"], distanceToCenterKm: 0.8 },
  { name: "如家快捷酒店", city: "北京", address: "朝阳区建国路", starRating: 3.0, userRating: 7.8, pricePerNight: 280, amenities: ["WiFi", "早餐", "停车场"], distanceToCenterKm: 3.5 },
  { name: "汉庭酒店", city: "北京", address: "西城区西单", starRating: 3.0, userRating: 8.0, pricePerNight: 350, amenities: ["WiFi", "早餐"], distanceToCenterKm: 2.0 },
  { name: "全季酒店", city: "北京", address: "海淀区中关村", starRating: 3.5, userRating: 8.5, pricePerNight: 450, amenities: ["WiFi", "早餐", "健身房"], distanceToCenterKm: 5.0 },
];

export const BEIJING_BUDGET_ATTRACTIONS: Activity[] = [
  { name: "天安门广场", category: "sightseeing", location: "北京", durationHours: 1.5, price: 0, rating: 9.0, description: "升旗仪式", timeSlot: "morning" },
  { name: "故宫博物院", category: "sightseeing", location: "北京", durationHours: 4.0, price: 60, rating: 9.5, description: "紫禁城", timeSlot: "morning" },
  { name: "景山公园", category: "sightseeing", location: "北京", durationHours: 1.5, price: 2, rating: 8.5, description: "俯瞰故宫", timeSlot: "afternoon" },
  { name: "南锣鼓巷", category: "experience", location: "北京", durationHours: 2.0, price: 0, rating: 8.0, description: "胡同文化", timeSlot: "afternoon" },
  { name: "什刹海", category: "experience", location: "北京", durationHours: 2.0, price: 0, rating: 8.0, description: "酒吧街夜景", timeSlot: "evening" },
];

export const BEIJING_BUDGET_RESTAURANTS: Activity[] = [
  { name: "庆丰包子铺", category: "dining", location: "北京", durationHours: 0.5, price: 15, rating: 7.5, description: "早餐包子", timeSlot: "morning", mealType: "breakfast" },
  { name: "护国寺小吃", category: "dining", location: "北京", durationHours: 1.0, price: 40, rating: 8.0, description: "午餐小吃", timeSlot: "afternoon", mealType: "lunch" },
  { name: "炸酱面馆", category: "dining", location: "北京", durationHours: 1.0, price: 50, rating: 7.5, description: "晚餐老北京", timeSlot: "evening", mealType: "dinner" },
];

// ─── Scenario 1.2: Guangzhou → Chengdu (luxury) ───

export const GUANGZHOU_CHENGDU_FLIGHTS: Flight[] = [
  { airline: "国航", flightNo: "CA4302", departureCity: "广州", arrivalCity: "成都", departureTime: "08:00", arrivalTime: "10:40", price: 1500, durationHours: 2.7, stops: 0, cabinClass: "economy" },
  { airline: "南航", flightNo: "CZ3402", departureCity: "广州", arrivalCity: "成都", departureTime: "11:00", arrivalTime: "13:40", price: 1200, durationHours: 2.7, stops: 0, cabinClass: "economy" },
  { airline: "川航", flightNo: "3U8802", departureCity: "广州", arrivalCity: "成都", departureTime: "14:00", arrivalTime: "16:40", price: 1100, durationHours: 2.7, stops: 0, cabinClass: "economy" },
  { airline: "国航", flightNo: "CA4302B", departureCity: "广州", arrivalCity: "成都", departureTime: "09:00", arrivalTime: "11:40", price: 3000, durationHours: 2.7, stops: 0, cabinClass: "business" },
];

export const GUANGZHOU_CHENGDU_RETURN_FLIGHTS: Flight[] = [
  { airline: "国航", flightNo: "CA4301", departureCity: "成都", arrivalCity: "广州", departureTime: "12:00", arrivalTime: "14:40", price: 1500, durationHours: 2.7, stops: 0, cabinClass: "economy" },
  { airline: "南航", flightNo: "CZ3401", departureCity: "成都", arrivalCity: "广州", departureTime: "16:00", arrivalTime: "18:40", price: 1200, durationHours: 2.7, stops: 0, cabinClass: "economy" },
  { airline: "川航", flightNo: "3U8801", departureCity: "成都", arrivalCity: "广州", departureTime: "08:00", arrivalTime: "10:40", price: 1100, durationHours: 2.7, stops: 0, cabinClass: "economy" },
  { airline: "国航", flightNo: "CA4301B", departureCity: "成都", arrivalCity: "广州", departureTime: "10:00", arrivalTime: "12:40", price: 2800, durationHours: 2.7, stops: 0, cabinClass: "business" },
];

export const CHENGDU_LUXURY_HOTELS: Hotel[] = [
  { name: "成都香格里拉大酒店", city: "成都", address: "锦江区", starRating: 5.0, userRating: 9.2, pricePerNight: 1200, amenities: ["SPA", "泳池", "米其林餐厅"], distanceToCenterKm: 1.5 },
  { name: "成都瑞吉酒店", city: "成都", address: "锦江区", starRating: 5.0, userRating: 9.0, pricePerNight: 1000, amenities: ["SPA", "管家服务"], distanceToCenterKm: 1.0 },
  { name: "成都太古里博舍", city: "成都", address: "锦江区", starRating: 5.0, userRating: 9.5, pricePerNight: 1500, amenities: ["SPA", "设计酒店", "下午茶"], distanceToCenterKm: 0.5 },
  { name: "成都钓鱼台精品酒店", city: "成都", address: "武侯区", starRating: 4.5, userRating: 8.8, pricePerNight: 800, amenities: ["SPA", "中餐厅"], distanceToCenterKm: 2.0 },
  { name: "成都茂业JW万豪", city: "成都", address: "锦江区", starRating: 5.0, userRating: 9.1, pricePerNight: 900, amenities: ["泳池", "行政酒廊"], distanceToCenterKm: 1.2 },
];

export const CHENGDU_LUXURY_ATTRACTIONS: Activity[] = [
  { name: "宽窄巷子", category: "experience", location: "成都", durationHours: 3.0, price: 0, rating: 8.5, description: "成都文化体验", timeSlot: "morning" },
  { name: "人民公园鹤鸣茶社", category: "experience", location: "成都", durationHours: 2.0, price: 30, rating: 9.0, description: "成都慢生活", timeSlot: "afternoon" },
  { name: "太古里IFS", category: "shopping", location: "成都", durationHours: 2.0, price: 0, rating: 8.0, description: "高端购物", timeSlot: "afternoon" },
  { name: "玉林路小酒馆", category: "experience", location: "成都", durationHours: 2.0, price: 80, rating: 8.5, description: "民谣酒吧", timeSlot: "evening" },
  { name: "火锅米其林推荐", category: "food", location: "成都", durationHours: 2.0, price: 200, rating: 9.0, description: "正宗成都火锅", timeSlot: "evening" },
];

export const CHENGDU_LUXURY_RESTAURANTS: Activity[] = [
  { name: "玉芝兰", category: "dining", location: "成都", durationHours: 2.0, price: 280, rating: 9.5, description: "米其林二星川菜", timeSlot: "morning", mealType: "breakfast" },
  { name: "廊桥", category: "dining", location: "成都", durationHours: 1.5, price: 150, rating: 8.8, description: "精致川菜午餐", timeSlot: "afternoon", mealType: "lunch" },
  { name: "蜀九香", category: "dining", location: "成都", durationHours: 2.0, price: 180, rating: 8.5, description: "正宗火锅晚餐", timeSlot: "evening", mealType: "dinner" },
];

// ─── Scenario 2.1: Wuhan → Jingdezhen (rail + B&B) ───

export const WUHAN_JINGDEZHEN_TRAINS: Train[] = [
  { trainNo: "G1461", trainType: "高铁", departureCity: "武汉", arrivalCity: "景德镇", departureTime: "07:30", arrivalTime: "10:45", price: 280, durationHours: 3.25, seatType: "二等座" },
  { trainNo: "G1463", trainType: "高铁", departureCity: "武汉", arrivalCity: "景德镇", departureTime: "13:00", arrivalTime: "16:15", price: 300, durationHours: 3.25, seatType: "二等座" },
  { trainNo: "D3227", trainType: "动车", departureCity: "武汉", arrivalCity: "景德镇", departureTime: "09:00", arrivalTime: "13:20", price: 200, durationHours: 4.33, seatType: "二等座" },
];

export const JINGDEZHEN_WUHAN_TRAINS: Train[] = [
  { trainNo: "G1462", trainType: "高铁", departureCity: "景德镇", arrivalCity: "武汉", departureTime: "11:00", arrivalTime: "14:15", price: 280, durationHours: 3.25, seatType: "二等座" },
  { trainNo: "G1464", trainType: "高铁", departureCity: "景德镇", arrivalCity: "武汉", departureTime: "16:30", arrivalTime: "19:45", price: 300, durationHours: 3.25, seatType: "二等座" },
  { trainNo: "D3228", trainType: "动车", departureCity: "景德镇", arrivalCity: "武汉", departureTime: "14:00", arrivalTime: "18:20", price: 200, durationHours: 4.33, seatType: "二等座" },
];

export const JINGDEZHEN_HOTELS: Hotel[] = [
  { name: "陶溪川国贸酒店", city: "景德镇", address: "珠山区陶溪川", starRating: 4.0, userRating: 8.5, pricePerNight: 380, amenities: ["WiFi", "早餐"], distanceToCenterKm: 1.0 },
  { name: "三宝村民宿", city: "景德镇", address: "昌江区三宝路", starRating: 3.0, userRating: 8.8, pricePerNight: 200, amenities: ["WiFi", "陶艺体验"], distanceToCenterKm: 5.0 },
  { name: "御窑厂旁客栈", city: "景德镇", address: "珠山区御窑路", starRating: 3.5, userRating: 8.0, pricePerNight: 250, amenities: ["WiFi"], distanceToCenterKm: 0.5 },
  { name: "景德镇国际大酒店", city: "景德镇", address: "珠山区广场北路", starRating: 4.0, userRating: 7.5, pricePerNight: 350, amenities: ["WiFi", "早餐", "停车场"], distanceToCenterKm: 2.0 },
];

export const JINGDEZHEN_ATTRACTIONS: Activity[] = [
  { name: "中国陶瓷博物馆", category: "museum", location: "景德镇", durationHours: 3.0, price: 0, rating: 9.0, description: "陶瓷历史", timeSlot: "morning" },
  { name: "御窑厂遗址", category: "history", location: "景德镇", durationHours: 2.5, price: 50, rating: 8.5, description: "明清御窑", timeSlot: "afternoon" },
  { name: "陶溪川文创街区", category: "experience", location: "景德镇", durationHours: 3.0, price: 0, rating: 8.5, description: "周末集市", timeSlot: "evening" },
  { name: "古窑民俗博览区", category: "museum", location: "景德镇", durationHours: 2.5, price: 95, rating: 8.0, description: "传统制瓷", timeSlot: "morning" },
  { name: "三宝蓬艺术聚落", category: "experience", location: "景德镇", durationHours: 2.0, price: 0, rating: 8.0, description: "艺术工作室", timeSlot: "afternoon" },
];

export const JINGDEZHEN_RESTAURANTS: Activity[] = [
  { name: "冷粉店", category: "dining", location: "景德镇", durationHours: 0.5, price: 15, rating: 7.5, description: "景德镇冷粉", timeSlot: "morning", mealType: "breakfast" },
  { name: "粑粑小吃", category: "dining", location: "景德镇", durationHours: 1.0, price: 50, rating: 8.0, description: "地方特色午餐", timeSlot: "afternoon", mealType: "lunch" },
  { name: "饺子粑老店", category: "dining", location: "景德镇", durationHours: 1.0, price: 60, rating: 8.0, description: "地方特色晚餐", timeSlot: "evening", mealType: "dinner" },
];

// ─── Scenario 3.1: Dali → Tengchong (no rail/flight) ───

export const DALI_TENGCHONG_HOTELS: Hotel[] = [
  { name: "腾冲热海温泉度假酒店", city: "腾冲", address: "热海路", starRating: 4.5, userRating: 9.0, pricePerNight: 500, amenities: ["温泉", "SPA"], distanceToCenterKm: 8.0 },
  { name: "和顺古镇民宿", city: "腾冲", address: "和顺古镇", starRating: 3.5, userRating: 8.5, pricePerNight: 280, amenities: ["WiFi", "早餐"], distanceToCenterKm: 3.0 },
  { name: "腾冲官房酒店", city: "腾冲", address: "腾越镇", starRating: 4.0, userRating: 8.0, pricePerNight: 350, amenities: ["WiFi", "温泉"], distanceToCenterKm: 2.0 },
];

export const DALI_TENGCHONG_ATTRACTIONS: Activity[] = [
  { name: "热海温泉", category: "relaxation", location: "腾冲", durationHours: 3.0, price: 180, rating: 9.0, description: "天然温泉", timeSlot: "afternoon" },
  { name: "和顺古镇", category: "history", location: "腾冲", durationHours: 3.0, price: 55, rating: 8.5, description: "百年古镇", timeSlot: "morning" },
  { name: "火山地质公园", category: "sightseeing", location: "腾冲", durationHours: 2.5, price: 40, rating: 8.0, description: "火山地貌", timeSlot: "morning" },
  { name: "北海湿地", category: "nature", location: "腾冲", durationHours: 2.0, price: 30, rating: 8.0, description: "高原湿地", timeSlot: "afternoon" },
  { name: "国殇墓园", category: "history", location: "腾冲", durationHours: 1.5, price: 0, rating: 8.5, description: "抗战纪念", timeSlot: "morning" },
];

export const DALI_TENGCHONG_RESTAURANTS: Activity[] = [
  { name: "大救驾", category: "dining", location: "腾冲", durationHours: 0.5, price: 15, rating: 7.5, description: "腾冲饵丝", timeSlot: "morning", mealType: "breakfast" },
  { name: "土锅子", category: "dining", location: "腾冲", durationHours: 1.0, price: 60, rating: 8.0, description: "特色火锅午餐", timeSlot: "afternoon", mealType: "lunch" },
  { name: "和顺家常菜", category: "dining", location: "腾冲", durationHours: 1.0, price: 70, rating: 8.0, description: "家常菜晚餐", timeSlot: "evening", mealType: "dinner" },
];
