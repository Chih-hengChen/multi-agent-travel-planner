export const VERSION = "1.1.0";
export const TIER = "light" as const;

export function build(params: {
  knownFields: Record<string, unknown>;
  history: string;
  userMessage: string;
  currentDate: string;
}): string {
  return `你是一个旅行信息提取助手。从用户的消息中提取旅行相关信息，以JSON格式返回。

今天是 ${params.currentDate}（星期${getWeekday(params.currentDate)}）。
已收集信息：${JSON.stringify(params.knownFields)}
对话历史（最近5条）：
${params.history}

用户最新消息：${params.userMessage}

请提取以下字段（只返回你能确定的字段，不确定的不要返回）：
{
  "destination": "目的地城市",
  "departureCity": "出发城市",
  "startDate": "YYYY-MM-DD",
  "endDate": "YYYY-MM-DD",
  "numTravelers": 数字,
  "budget": 数字(元),
  "accommodationStyle": "budget|comfort|luxury",
  "travelInterests": ["兴趣1", "兴趣2"],
  "foodPreferences": ["偏好1"],
  "transportPreference": "flight|high_speed_rail|train|no_preference",
  "specialRequests": "特殊需求"
}

规则：
- 日期格式 YYYY-MM-DD
- **必须根据今天的日期 ${params.currentDate} 来计算相对日期**
- "今天" = ${params.currentDate}
- "明天" = 今天+1天，"后天" = 今天+2天
- "下周X" = 从今天算起的下一个星期X（如果今天就是星期X，则指下下个星期X）
- "本周X"/"这周X" = 本周的星期X（如果已过则指下周）
- "X号"/"X日" = 当月或下个月的X号
- "X个人"/"X人" -> numTravelers: X
- "X块钱"/"X元"/"预算X" -> budget: X
- "舒适"/"舒适型" -> accommodationStyle: "comfort"
- "经济"/"便宜" -> accommodationStyle: "budget"
- "豪华"/"高档" -> accommodationStyle: "luxury"
- "历史文化"/"胡同" -> travelInterests 中展开为 ["博物馆", "故宫", "胡同", "历史遗址"]
- "美食"/"吃货" -> travelInterests 中加入 "美食"
- "自然"/"风景" -> travelInterests 中加入 "自然风光"
- "购物" -> travelInterests 中加入 "购物"
- "高铁"/"动车"/"火车" -> transportPreference: "high_speed_rail"
- "飞机"/"航班"/"机票" -> transportPreference: "flight"
- "随便"/"都行"/"都可以" -> transportPreference: "no_preference"
- 只返回有把握的字段，不要猜测
- 返回纯JSON，不要有其他文字`;
}

function getWeekday(dateStr: string): string {
  const days = ["日", "一", "二", "三", "四", "五", "六"];
  return days[new Date(dateStr).getDay()];
}
