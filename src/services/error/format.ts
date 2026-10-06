// ==========================================
// 错误归一化 —— 无依赖叶子模块
// Rust 命令的错误形态由裸 String 迁移到 { code, message }，
// 这里统一兼容两种形态，供 logger / 全局异常体系共用。
// 刻意不 import 任何模块：它会被 logger 和 global-error 同时引用。
// ==========================================

/** Rust `AppError` 序列化后的形态 */
export interface AppErrorPayload {
  code: string
  message: string
}

export function isAppErrorPayload(value: unknown): value is AppErrorPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AppErrorPayload).code === "string" &&
    typeof (value as AppErrorPayload).message === "string"
  )
}

/** 把任意抛出物转成可读单行文本 */
export function formatError(value: unknown): string {
  if (value === null || value === undefined) return String(value)
  if (typeof value === "string") return value
  if (value instanceof Error) return value.message || value.name
  if (isAppErrorPayload(value)) return value.message
  if (typeof value === "object" && "message" in value) {
    const message = (value as { message?: unknown }).message
    if (typeof message === "string") return message
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** 取远端载荷或宿主 Error 上的稳定错误码；裸 String / 无码 Error 返回 null。 */
export function errorCode(value: unknown): string | null {
  if (isAppErrorPayload(value)) return value.code
  if (value instanceof Error && "code" in value) {
    const code = (value as Error & { code?: unknown }).code
    return typeof code === "string" ? code : null
  }
  return null
}

/** 完整详情（Error 带 stack），用于日志与错误面板 */
export function errorDetail(value: unknown): string {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`
  if (isAppErrorPayload(value)) return `${value.code}: ${value.message}`
  return formatError(value)
}

/**
 * 常见密钥形态 —— 会随消息持久化进 session 文件，展示前必须打码。
 * 每条规则都必须带捕获组：替换串 `$1***` 依赖第 1 组保留前缀（如 `Bearer `、
 * `"apiKey":"`、`sk-`）；没有捕获组的规则不会报错，但 `$1` 会作为字面量留在输出里。
 */
const SECRET_PATTERNS: RegExp[] = [
  /(sk-)[A-Za-z0-9_-]{8,}/g,
  /(Bearer\s+)[A-Za-z0-9._-]{8,}/gi,
  /("?(?:api[_-]?key|token|secret|password)"?\s*[:=]\s*"?)[^"\s,}]{8,}/gi,
]

/** 摘要默认长度上限（字符）：打码后仍超长的错误摘要在末尾截断并加省略号。 */
const DEFAULT_SUMMARY_MAX_LENGTH = 120

/** 打码后再截断，用于会落盘/展示给用户的错误摘要 */
export function summarizeError(value: unknown, maxLength = DEFAULT_SUMMARY_MAX_LENGTH): string {
  let text = formatError(value)
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "$1***")
  text = text.replace(/\s+/g, " ").trim()
  return text.length > maxLength ? text.slice(0, maxLength) + "…" : text
}
