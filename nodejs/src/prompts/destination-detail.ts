export const VERSION = "1.0.0";
export const TIER = "heavy" as const;

export function build(params: { city: string; budget: number }): string {
  return `请为旅行目的地"${params.city}"生成以下信息，严格以 JSON 格式返回（不要其他文字）：
{"city":"${params.city}","country":"国家","description":"一句话描述","bestSeason":"spring,summer,autumn或winter","visaRequired":false,"safetyScore":8.5,"costLevel":"low/medium/high","highlights":["景点1","景点2","景点3","景点4"]}

重要：city 字段必须严格为"${params.city}"，不得更改。
预算参考：${params.budget}元人民币。costLevel 应根据该城市的一般消费水平和预算匹配度来设定。safetyScore 范围 0-10。`;
}
