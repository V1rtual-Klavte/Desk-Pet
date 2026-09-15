// ==========================================
// Provider 网络防护 —— 协议白名单 + 响应体大小上限
// ==========================================
//
// 零依赖叶子模块：只回答「请求能发向哪里」和「最多读多少字节」两个问题，
// 不 import config / logger / Pi，任何一层引用它都不会成环。
// 所有 Pi 请求（主链路 piStream 与一次性 completePiText）都经这里出网。

/** 一次性 Provider 调用（planner / 压缩 / 记忆 / 阶段文案）的总时限 */
export const PROVIDER_TIMEOUT_MS = 60_000

/** 单个 Provider 响应体的字节上限 */
export const MAX_PROVIDER_RESPONSE_BYTES = 4 * 1024 * 1024

/** 协议白名单：只放行 http/https，`file:` 等一律拒绝。 */
export function validateProviderUrl(value: string): URL {
  const parsed = new URL(value)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Provider URL 协议不允许")
  return parsed
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.toString()
  return input.url
}

/**
 * 限制 Provider 响应体大小，超限即抛错。
 *
 * 计数与拼接都用手写 reader 循环，不用 TransformStream（老 WKWebView 没有它）。
 * 超限时先 `reader.cancel()` 停止下载再抛错，不让连接继续占着。
 * 返回的 Response 复用原 status/statusText/headers；body 已是 fetch 解码后的
 * 明文字节，因此不会出现二次解压。
 */
export async function capProviderResponseBody(response: Response): Promise<Response> {
  const declared = Number(response.headers.get("content-length") ?? 0)
  if (declared > MAX_PROVIDER_RESPONSE_BYTES) throw new Error("Provider 响应超过大小上限")
  if (!response.body) return response
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error("Provider 响应超过大小上限")
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new Response(merged, {
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
export async function guardProviderFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  validateProviderUrl(requestUrl(input))
  const response = await globalThis.fetch(input, init)
  return capProviderResponseBody(response)
}
