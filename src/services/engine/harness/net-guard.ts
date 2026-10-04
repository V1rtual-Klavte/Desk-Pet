// ==========================================
// Provider 网络防护 —— 固定 origin、禁止重定向与响应体大小上限
// ==========================================
//
// 零依赖叶子模块：只回答「请求能发向哪里」和「最多读多少字节」两个问题，
// 不 import config / logger / Pi，任何一层引用它都不会成环。
// 所有 Pi 请求（主链路 piStream 与一次性 completePiText）都经这里出网。

/** 一次性 Provider 调用（planner / 压缩 / 记忆 / 阶段文案）的总时限 */
export const PROVIDER_TIMEOUT_MS = 60_000

/** 响应体上限的固定基线（协议头、用量与流式包封的公共部分）。 */
export const MAX_PROVIDER_RESPONSE_BASE_BYTES = 1 * 1024 * 1024
/**
 * 每个输出 token 预留的流式字节。
 *
 * 旧值是固定 4 MiB 总上限：输出预算还叫 4k 时够用，但预算改为按窗口推导后，
 * reasoning 模型的思考与 JSON 包封会按 token 数放大，16k 输出就可能超过 4 MiB。
 * 512B/token 覆盖实测的 SSE 分块与包封开销（约 256B/token）并留一倍余量；
 * 上限仍随请求输出预算有界，不放开成无限制读取。
 */
export const PROVIDER_RESPONSE_BYTES_PER_TOKEN = 512

/** 按本次最大输出推导响应体上限：基线 + 输出预算 × 每 token 预留。 */
export function providerResponseByteCap(maxOutputTokens: number): number {
  return MAX_PROVIDER_RESPONSE_BASE_BYTES + Math.max(0, Math.floor(maxOutputTokens)) * PROVIDER_RESPONSE_BYTES_PER_TOKEN
}

/** 协议白名单：只放行 http/https，`file:` 等一律拒绝。 */
export function validateProviderUrl(value: string): URL {
  const parsed = new URL(value)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Provider URL 协议不允许")
  if (parsed.username || parsed.password) throw new Error("Provider URL 不允许内嵌凭据")
  return parsed
}

/**
 * 把用户设置的 endpoint 归一为唯一允许的 Provider origin。
 *
 * localhost 与私有地址是用户显式配置的本地模型服务，允许使用；本层只约束
 * 浏览器实际请求不会离开这个 origin。没有 Rust 代理时无法防止 DNS rebinding，
 * 因而不能把它描述成通用 SSRF/DNS 防护。
 */
export function configuredProviderOrigin(endpoint: string): string {
  return validateProviderUrl(endpoint).origin
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.toString()
  return input.url
}

/**
 * 限制 Provider 响应体大小，超限即抛错。
 *
 * 返回一个按 chunk 计数的 ReadableStream，不预读、不整段缓冲 SSE。超限时先
 * 取消上游 reader 再报错，避免连接继续占用网络和内存。
 */
export async function capProviderResponseBody(response: Response, maxBytes: number): Promise<Response> {
  const declared = Number(response.headers.get("content-length") ?? 0)
  if (declared > maxBytes) {
    await response.body?.cancel()
    throw new Error("Provider 响应超过大小上限")
  }
  if (!response.body) return response
  const reader = response.body.getReader()
  let total = 0
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) {
          reader.releaseLock()
          controller.close()
          return
        }
        total += next.value.byteLength
        if (total > maxBytes) {
          await reader.cancel()
          controller.error(new Error("Provider 响应超过大小上限"))
          return
        }
        controller.enqueue(next.value)
      } catch (error) {
        controller.error(error)
      }
    },
    async cancel(reason) {
      await reader.cancel(reason)
    },
  })
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

/**
 * 可直接交给 pi-ai `options.fetch` 的 fetch 实现。
 *
 * 校验协议 → 走 globalThis.fetch → 限制响应体大小。传输层错误（比如
 * 网络不可达的 TypeError）原样抛出，由 pi-ai 归一化成 `stopReason: "error"`
 * 的 AssistantMessage，不在这里改写文案。
 */
export async function guardProviderFetch(input: RequestInfo | URL, init?: RequestInit, maxBytes = providerResponseByteCap(4_096)): Promise<Response> {
  validateProviderUrl(requestUrl(input))
  // 不跟随 30x，避免 Authorization/API Key 被转发到重定向目标。
  const response = await globalThis.fetch(input, { ...init, redirect: "error" })
  return capProviderResponseBody(response, maxBytes)
}

/**
 * 为一个配置快照创建 fetch 边界。所有请求都必须留在 endpoint 的同一 origin；
 * path/query 可由 pi-ai 正常追加，host、scheme 或 port 的漂移一律拒绝。
 */
export function createProviderFetchGuard(endpoint: string, maxBytes = providerResponseByteCap(4_096)): typeof fetch {
  const origin = configuredProviderOrigin(endpoint)
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = validateProviderUrl(requestUrl(input))
    if (request.origin !== origin) throw new Error("Provider 请求目标不在已配置 origin 内")
    return guardProviderFetch(input, init, maxBytes)
  }
}
