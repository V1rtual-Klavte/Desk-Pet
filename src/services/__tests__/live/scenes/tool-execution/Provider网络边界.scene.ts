import type { SceneDef } from "../../types"
import { MAX_PROVIDER_RESPONSE_BYTES, capProviderResponseBody, createProviderFetchGuard, validateProviderUrl } from "@/services/engine/pi"

export const Provider网络边界: SceneDef = {
  meta: { caseId: "tool-provider-network-boundary", module: "tool-execution", contractId: "te-09", description: "Provider URL 协议边界与响应体上限", depth: "shallow", suite: "safety", tags: ["tool-execution", "boundary", "error"] },
  turns: [{ index: 1, description: "校验 Provider 网络地址与响应体上限", userText: "检查网络地址策略。", checks: [{ type: "expectReply", run: async () => {
    if (validateProviderUrl("https://localhost/v1").protocol !== "https:") throw new Error("HTTPS 未放行")
    let rejected = false
    try { validateProviderUrl("file:///tmp/provider") } catch { rejected = true }
    if (!rejected) throw new Error("非 HTTP 协议未拒绝")

    const configured = createProviderFetchGuard("https://provider.example:8443/v1")
    for (const url of ["https://other.example:8443/v1", "http://provider.example:8443/v1", "https://provider.example/v1"]) {
      let originRejected = false
      try { await configured(url) } catch { originRejected = true }
      if (!originRejected) throw new Error(`不同 Provider origin 未拒绝: ${url}`)
    }

    // 用户显式配置的 localhost/private provider 是合法目标；guard 只固定其 origin。
    const originalFetch = globalThis.fetch
    let redirectMode: RequestRedirect | undefined
    globalThis.fetch = async (_input, init) => {
      redirectMode = init?.redirect
      return new Response("ok")
    }
    try {
      const localProvider = createProviderFetchGuard("http://localhost:11434/v1")
      const localResponse = await localProvider("http://localhost:11434/v1/chat")
      if (await localResponse.text() !== "ok") throw new Error("显式 localhost Provider 未放行")
      if (redirectMode !== "error") throw new Error("Provider 请求没有禁用重定向")
    } finally {
      globalThis.fetch = originalFetch
    }

    // content-length 预检：声明超限时不必读 body 就拒绝
    let declaredRejected = false
    try {
      await capProviderResponseBody(new Response("x", { headers: { "content-length": String(MAX_PROVIDER_RESPONSE_BYTES + 1) } }))
    } catch { declaredRejected = true }
    if (!declaredRejected) throw new Error("content-length 超限未拒绝")

    // 流式超限：无 content-length，按累计读取字节数拒绝
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_PROVIDER_RESPONSE_BYTES + 1))
        controller.close()
      },
    })
    let streamRejected = false
    try {
      await (await capProviderResponseBody(new Response(oversized))).arrayBuffer()
    } catch { streamRejected = true }
    if (!streamRejected) throw new Error("流式响应超限未拒绝")

    let upstream: ReadableStreamDefaultController<Uint8Array> | undefined
    let cancelled = false
    const source = new ReadableStream<Uint8Array>({
      start(controller) { upstream = controller; controller.enqueue(new Uint8Array([1])) },
      cancel() { cancelled = true },
    })
    const guarded = await capProviderResponseBody(new Response(source))
    const reader = guarded.body!.getReader()
    const first = await reader.read()
    if (first.value?.[0] !== 1) throw new Error("首块没有增量交付")
    await reader.cancel()
    if (!cancelled || !upstream) throw new Error("消费者取消未传播到上游")
  } }] }],
}

export default Provider网络边界
