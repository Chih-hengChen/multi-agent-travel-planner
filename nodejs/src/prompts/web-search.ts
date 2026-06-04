export const VERSION = "2.0.0";
export const TIER = "heavy" as const;

export function buildSystemPrompt(params: { kind: string }): string {
  return `你是数据提取助手。从用户提供的网页搜索结果中，提取${params.kind}相关的结构化信息。
只返回JSON数组，不要其他文字。如果没有可靠数据，返回空数组 []。

规则：
1. 只从提供的搜索结果中提取，不要编造数据
2. 价格必须是数字（去掉货币符号）
3. 时间格式为 HH:MM
4. 如果搜索结果中没有明确的价格/时间，使用 null`;
}

export function buildUserPrompt(params: { query: string; kind: string; searchContext: string }): string {
  return `查询：${params.query}

以下是真实的网页搜索结果：

${params.searchContext}

请从以上搜索结果中提取${params.kind}信息，返回JSON数组。每个元素包含相关字段。如果没有可靠数据，返回空数组 []。`;
}
