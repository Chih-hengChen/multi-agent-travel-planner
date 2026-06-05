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
  "outboundTransportPreference": "flight|high_speed_rail|train|no_preference",
  "returnTransportPreference": "flight|high_speed_rail|train|no_preference",
  "specialRequests": "特殊需求",
  "mustVisitAttractions": ["景点名1", "景点名2"]
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
- "连锁"/"连锁品牌"/"快捷"/"如家"/"汉庭"/"全季"/"民宿"/"客栈" -> accommodationStyle: "comfort"
- "星级酒店"/"五星"/"四星" -> accommodationStyle: "luxury"
- "青旅"/"背包客" -> accommodationStyle: "budget"
- 只要用户提到了住宿偏好（任何描述），都应提取为 accommodationStyle
- "历史文化"/"胡同" -> travelInterests 中展开为 ["博物馆", "故宫", "胡同", "历史遗址"]
- "美食"/"吃货" -> travelInterests 中加入 "美食"
- "自然"/"风景" -> travelInterests 中加入 "自然风光"
- "购物" -> travelInterests 中加入 "购物"
- "高铁"/"动车"/"火车" -> outboundTransportPreference: "high_speed_rail"
- "飞机"/"航班"/"机票" -> outboundTransportPreference: "flight"
- "随便"/"都行"/"都可以" -> outboundTransportPreference: "no_preference"
- **去程返程独立偏好**：
  - "去程高铁，返程飞机" -> outboundTransportPreference: "high_speed_rail", returnTransportPreference: "flight"
  - "去程飞机，返程高铁" -> outboundTransportPreference: "flight", returnTransportPreference: "high_speed_rail"
  - "去程XX"只设置 outboundTransportPreference，"返程YY"只设置 returnTransportPreference
  - 如果只说了"高铁"没区分去返程 -> 两个字段设相同值
- 用户提到具体景点/地点名称时提取到 mustVisitAttractions 数组
- "想去故宫、颐和园和国博" -> mustVisitAttractions: ["故宫", "颐和园", "国博"]
- "还想去雍和宫拜一拜" -> 追加到 mustVisitAttractions
- "一定要去长城" -> 追加到 mustVisitAttractions
- 多次对话中提到的景点应累积合并到同一个数组
- 只返回有把握的字段，不要猜测
- 返回纯JSON，不要有其他文字`;
}

function getWeekday(dateStr: string): string {
  const days = ["日", "一", "二", "三", "四", "五", "六"];
  return days[new Date(dateStr).getDay()];
}
