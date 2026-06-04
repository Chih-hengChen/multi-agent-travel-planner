export const VERSION = "2.3.0";
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

const EXAMPLES: Record<string, { input: string; output: string }> = {
  trains: {
    input: `来源1: 武汉到北京高铁查询-高铁票价-高铁时刻表
G402 高速铁路 武汉-北京西 16:21-21:59 5小时49分 二等座 520.5 一等座 832.5
来源2: 2026北京到武汉高铁时刻表查询
G340 武汉 3时55分 北京西 二等座 623 一等座 997 商务座 1960
来源3: G516高铁动车车次时刻表
车次G516 武汉-北京西 4小时20分 硬座616.5 发车13:30 到达17:50`,
    output: `[
  {"trainNo":"G402","trainType":"高铁","departureCity":"武汉","arrivalCity":"北京西","departureTime":"16:21","arrivalTime":"21:59","price":520.5,"durationHours":6,"seatType":"二等座"},
  {"trainNo":"G340","trainType":"高铁","departureCity":"武汉","arrivalCity":"北京西","departureTime":"07:40","arrivalTime":"11:35","price":623,"durationHours":4,"seatType":"二等座"},
  {"trainNo":"G516","trainType":"高铁","departureCity":"武汉","arrivalCity":"北京西","departureTime":"13:30","arrivalTime":"17:50","price":616.5,"durationHours":4,"seatType":"二等座"}
]`,
  },
};

export function buildSystemPrompt(params: { kind: string }): string {
  const spec = FIELD_SPECS[params.kind] ?? "";
  const example = EXAMPLES[params.kind];

  let prompt = `你是数据提取助手。从用户提供的网页搜索结果中，提取${params.kind}相关的结构化信息。
只返回JSON数组，不要其他文字。

返回格式（每个元素的结构）：
${spec}

规则：
1. 从搜索结果文本中尽可能提取信息，搜索结果的描述中通常包含车次号、时间、价格等关键信息
2. 价格必须是数字（去掉¥、元等符号）
3. 时间格式为 HH:MM
4. 字段名必须与上面格式完全一致
5. 尽力提取，即使某些字段需要从文本中推断（如从"5小时49分"推断durationHours为5）`;

  if (example) {
    prompt += `

示例输入：
${example.input}

示例输出：
${example.output}`;
  }

  return prompt;
}

export function buildUserPrompt(params: { query: string; kind: string; searchContext: string; cityKnowledge?: string }): string {
  const knowledgeBlock = params.cityKnowledge
    ? `\n以下是该城市的百科旅游参考信息（知名度高的景点推荐）：\n${params.cityKnowledge}\n`
    : "";

  return `查询：${params.query}
${knowledgeBlock}
以下是真实的网页搜索结果：

${params.searchContext}

请从以上所有信息中提取${params.kind}信息，严格按照指定字段名返回JSON数组。百科信息中的知名景点优先提取。`;
}
