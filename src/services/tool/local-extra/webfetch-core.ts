// ==========================================
// 网页抓取：URL 准入、DeepSeek Fetch 请求与结果整理
// ==========================================
//
// 抓取由 DeepSeek 服务端执行（POST /v1/tools/fetch），本机只做 URL 预检与结果整理。
// 预检不是本地 SSRF 边界：私网拒绝挡住的是「把本机/内网地址发给远端服务」的误用，
// 真正的解析与出网发生在 DeepSeek 一侧。

import type { ToolResult } from "../types"
import { formatError } from "@/services/error"

export const WEB_FETCH_MAX_URL_CHARS = 8192
export const WEB_FETCH_MAX_CONTENT_CHARS = 200_000

export interface WebFetchDeps {
  fetch: (input: string, init: RequestInit) => Promise<Response>
  endpoint: string
  apiKey: string
  signal?: AbortSignal
}

export interface WebFetchPayload {
  title: string
  content: string
  truncated: boolean
}

/** 只接受可公开访问的 http/https 地址；返回规范化后的 URL 作为请求体与回显来源。 */
export function normalizeFetchUrl(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("url 不能为空")
  const trimmed = raw.trim()
  if (trimmed.length > WEB_FETCH_MAX_URL_CHARS) {
    throw new Error(`url 过长（上限 ${WEB_FETCH_MAX_URL_CHARS} 字符）`)
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error("url 不是有效的绝对地址")
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("只支持 http/https 网页地址")
  }
  if (parsed.username || parsed.password) {
    throw new Error("url 不能包含用户名或密码")
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new Error("不抓取本机或内网地址")
  }
  const normalized = parsed.toString()
  if (normalized.length > WEB_FETCH_MAX_URL_CHARS) {
    throw new Error(`url 过长（上限 ${WEB_FETCH_MAX_URL_CHARS} 字符）`)
  }
  return normalized
}

function isPrivateHost(hostname: string): boolean {
  if (!hostname) return true
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (host.includes("%")) return true // IPv6 zone id 指向本地接口
  if (host.includes(":")) return isPrivateIpv6(host)
  if (host === "localhost" || host.endsWith(".localhost")) return true
  if (host.endsWith(".local") || host.endsWith(".internal")) return true
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return isPrivateIpv4(host)
  // 单标签主机名没有公共后缀，只能在内网解析。
  return !host.includes(".")
}

function isPrivateIpv4(host: string): boolean {
  const [a, b] = host.split(".").map(Number)
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 169 && b === 254) return true // 链路本地 / 云元数据
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && (b === 0 || b === 168)) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  return a >= 224 // 组播与保留段
}

function isPrivateIpv6(host: string): boolean {
  if (host === "::" || host === "::1") return true
  const first = host.split(":")[0]
  if (/^f[cd][0-9a-f]{0,2}$/.test(first)) return true // fc00::/7 唯一本地地址
  if (/^fe[89ab][0-9a-f]?$/.test(first)) return true // fe80::/10 链路本地
  if (/^ff[0-9a-f]{0,2}$/.test(first)) return true // 组播
  return host.startsWith("::ffff:") // IPv4 映射（含十六进制写法）
}

export function buildFetchRequest(
  endpoint: string,
  apiKey: string,
  url: string,
  signal?: AbortSignal,
): { requestUrl: string; init: RequestInit } {
  const base = endpoint.trim().replace(/\/+$/, "")
  if (!base) throw new Error("未配置模型服务 endpoint")
  const requestUrl = base.endsWith("/tools/fetch")
    ? base
    : base.endsWith("/v1")
      ? `${base}/tools/fetch`
      : `${base}/v1/tools/fetch`
  const init: RequestInit = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url }),
    redirect: "error",
    ...(signal ? { signal } : {}),
  }
  return { requestUrl, init }
}

export function parseFetchPayload(payload: unknown): WebFetchPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("抓取服务返回了无效响应")
  }
  const record = payload as Record<string, unknown>
  const title = typeof record.title === "string" ? record.title.trim() : ""
  const rawContent = typeof record.content === "string" ? record.content.trim() : ""
  if (!rawContent) throw new Error("页面没有可读正文")
  const truncated = rawContent.length > WEB_FETCH_MAX_CONTENT_CHARS
  return {
    title,
    content: truncated ? rawContent.slice(0, WEB_FETCH_MAX_CONTENT_CHARS) : rawContent,
    truncated,
  }
}

export function formatFetchResult(url: string, payload: WebFetchPayload): string {
  const head = payload.title ? `标题：${payload.title}\n来源：${url}` : `来源：${url}`
  const tail = payload.truncated ? `\n\n[正文过长，仅保留前 ${WEB_FETCH_MAX_CONTENT_CHARS} 个字符]` : ""
  return `${head}\n\n${payload.content}${tail}`
}

export async function runWebFetch(
  params: Record<string, unknown>,
  deps: WebFetchDeps,
): Promise<ToolResult> {
  try {
    const url = normalizeFetchUrl(params.url)
    const { requestUrl, init } = buildFetchRequest(deps.endpoint, deps.apiKey, url, deps.signal)
    const response = await deps.fetch(requestUrl, init)
    if (!response.ok) {
      return {
        success: false,
        content: "",
        error: describeHttpFailure(response.status),
        errorCode: response.status === 401 || response.status === 403 ? "denied" : "failed",
      }
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      return { success: false, content: "", error: "抓取服务返回的不是有效 JSON", errorCode: "failed" }
    }
    return { success: true, content: formatFetchResult(url, parseFetchPayload(payload)) }
  } catch (error) {
    if (deps.signal?.aborted) {
      return { success: false, content: "", error: "网页抓取已取消", errorCode: "cancelled" }
    }
    return { success: false, content: "", error: formatError(error), errorCode: "failed" }
  }
}

function describeHttpFailure(status: number): string {
  if (status === 400) return "网页抓取请求无效（HTTP 400），请检查 URL 与请求参数"
  if (status === 401) return "网页抓取认证失败（HTTP 401），请检查 DeepSeek API Key"
  if (status === 402) return "网页抓取余额不足（HTTP 402），请充值后重试"
  if (status === 403) return "网页抓取被安全策略拒绝（HTTP 403），请调整目标地址"
  if (status === 404) return "网页抓取未获得可用正文（HTTP 404），目标可能不可访问、被站点策略阻止或不支持正文提取"
  if (status === 408) return "抓取服务读取请求超时（HTTP 408），请稍后重试"
  if (status === 413) return "网页抓取请求体过大（HTTP 413），请缩短请求"
  if (status === 429) return "网页抓取被限流（HTTP 429），请稍后再试"
  if (status >= 500 && status <= 599) return `网页抓取服务暂时不可用（HTTP ${status}），请稍后重试`
  return `网页抓取失败（HTTP ${status}）`
}
