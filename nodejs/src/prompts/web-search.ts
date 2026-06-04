export const VERSION = "2.1.0";
export const TIER = "heavy" as const;

const FIELD_SPECS: Record<string, string> = {
  trains: `{
    "trainNo": "G340",
    "trainType": "高铁",
    "departureCity": "武汉",
    "arrivalCity": "北京西",
    "departureTime": "07:40",
    "arrivalTime": "11:35",
    "price": 623,
    "durationHours": 4,
    "seatType": "二等座"
  }`,
  flights: `{
    "airline": "中国国航",
    "flightNo": "CA1234",
    "departureTime": "08:00",
    "arrivalTime": "10:30",
    "price": 800,
    "durationHours": 2.5
  }`,
  hotels: `{
    "name": "如家酒店北京天安门店",
    "address": "北京市东城区xxx",
    "starRating": 3,
    "userRating": 8.5,
    "pricePerNight": 380,
    "amenities": ["wifi", "早餐"],
    "distanceToCenterKm": 1.2
  }`,
  attractions: `{
    "name": "故宫博物院",
    "category": "历史文化",
    "location": "北京",
    "durationHours": 3,
    "price": 60,
    "rating": 9.5
  }`,
  restaurants: `{
    "name": "全聚德烤鸭店",
    "cuisine": "北京菜",
    "location": "北京",
    "price": 150,
    "rating": 8.0
  }`,
};

export function buildSystemPrompt(params: { kind: string }): string {
  const spec = FIELD_SPECS[params.kind] ?? "";
  return `你是数据提取助手。从用户提供的网页搜索结果中，提取${params.kind}相关的结构化信息。
只返回JSON数组，不要其他文字。如果没有可靠数据，返回空数组 []。

返回格式（每个元素的结构）：
${spec}

规则：
1. 只从提供的搜索结果中提取，不要编造数据
2. 价格必须是数字（去掉货币符号和单位）
3. 时间格式为 HH:MM
4. 字段名必须与上面格式完全一致
5. 如果搜索结果中某个字段没有明确信息，设为 null`;
}

export function buildUserPrompt(params: { query: string; kind: string; searchContext: string }): string {
  return `查询：${params.query}

以下是真实的网页搜索结果：

${params.searchContext}

请从以上搜索结果中提取${params.kind}信息，严格按照指定字段名返回JSON数组。如果没有可靠数据，返回空数组 []。`;
}
