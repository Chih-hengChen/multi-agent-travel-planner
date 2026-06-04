export const VERSION = "1.0.0";
export const TIER = "heavy" as const;

export function buildUserPrompt(params: { query: string; kind: string }): string {
  return `搜索以下信息并以JSON数组返回结果。只返回纯JSON，不要其他文字。

查询：${params.query}

返回格式：JSON数组，每个元素包含相关的${params.kind}信息。如果没有可靠数据，返回空数组 []。`;
}

export function buildSystemPrompt(params: { kind: string }): string {
  return `你是一个数据搜索助手。根据用户的查询，从你的知识库中提供最准确的${params.kind}数据。只返回JSON。`;
}
