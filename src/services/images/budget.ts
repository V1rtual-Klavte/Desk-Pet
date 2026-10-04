/** 跨主请求／辅助视觉请求的统一保守预算；不把 base64 字符当成语言 token。 */
export const IMAGE_INPUT_TOKEN_RESERVE = 4096

export function imageInputTokens(content: unknown): number {
  if (!Array.isArray(content)) return 0
  return content.reduce((tokens, part) => tokens + (part && typeof part === "object" && part.type === "image" ? IMAGE_INPUT_TOKEN_RESERVE : 0), 0)
}
