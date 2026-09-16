import type { SceneDef } from "../../types"
import { MAX_PROVIDER_RESPONSE_BYTES, capProviderResponseBody, validateProviderUrl } from "@/services/engine/pi"

export const Provider网络边界: SceneDef = {
  meta: { caseId: "tool-provider-network-boundary", module: "tool-execution", contractId: "te-09", description: "Provider URL 协议边界与响应体上限", depth: "shallow", suite: "safety", tags: ["tool-execution", "boundary", "error"] },
  turns: [{ index: 1, description: "校验 Provider 网络地址与响应体上限", userText: "检查网络地址策略。", checks: [{ type: "expectReply", run: async () => {
    if (validateProviderUrl("https://localhost/v1").protocol !== "https:") throw new Error("HTTPS 未放行")
    let rejected = false
    try { validateProviderUrl("file:///tmp/provider") } catch { rejected = true }
    if (!rejected) throw new Error("非 HTTP 协议未拒绝")

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
