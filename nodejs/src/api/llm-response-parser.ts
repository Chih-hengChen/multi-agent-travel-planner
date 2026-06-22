export interface AnthropicContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  signature?: string;
}

export interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  error?: { message: string };
}

export function extractText(data: AnthropicResponse): string {
  const content = data.content ?? [];

  const textBlock = content.find((b) => b.type === "text" && b.text);
  if (textBlock) return textBlock.text;

  const thinkBlock = content.find(
    (b) => (b.type === "thinking" || b.thinking) && b.thinking,
  );
  if (thinkBlock?.thinking) {
    const m = thinkBlock.thinking.match(/\{[\s\S]*\}/);
    if (m) return m[0];
    return thinkBlock.thinking;
  }

  return content[0]?.text ?? "";
}
