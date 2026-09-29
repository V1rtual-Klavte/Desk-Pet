// ==========================================
// Provider 网络边界 —— 从 test/e2e/scenes/tool-execution/Provider网络边界.scene.ts 迁到 L3
// ==========================================
//
// 全是进程内断言：URL 协议白名单、origin 固定、禁止重定向、响应体字节上限与消费者
// 取消向上游传播 —— 不驱动模型、不碰 IPC。原场景未声明 entry（默认 runtime），会白跑
// 一次真实模型；迁到 L3 后这些断言以朴素 vitest 直接执行。
//
// 归属 L3（不是 L2）的理由：import `@/services/engine/pi`（pi barrel 会带出 runtime.ts，
// 规则 6 的 L2 禁入清单）；本文件实际只调用其中的零依赖网络防护叶子。
import { describe, expect, it } from "vitest"

import {
  MAX_PROVIDER_RESPONSE_BYTES,
  capProviderResponseBody,
  createProviderFetchGuard,
  validateProviderUrl,
} from "@/services/engine/pi"

describe("Provider 网络边界", () => {
  it("Provider URL 协议边界与响应体上限 [tool-provider-network-boundary]", async () => {
    expect(validateProviderUrl("https://localhost/v1").protocol).toBe("https:")
    expect(() => validateProviderUrl("file:///tmp/provider"), "非 HTTP 协议未拒绝").toThrow()

    // origin 固定：host / scheme / port 任一漂移都必须拒绝。
    const configured = createProviderFetchGuard("https://provider.example:8443/v1")
    for (const url of ["https://other.example:8443/v1", "http://provider.example:8443/v1", "https://provider.example/v1"]) {
      await expect(configured(url), `不同 Provider origin 未拒绝: ${url}`).rejects.toThrow()
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
      expect(await localResponse.text(), "显式 localhost Provider 未放行").toBe("ok")
      expect(redirectMode, "Provider 请求没有禁用重定向").toBe("error")
    } finally {
      globalThis.fetch = originalFetch
    }

    // content-length 预检：声明超限时不必读 body 就拒绝
    await expect(
      capProviderResponseBody(new Response("x", { headers: { "content-length": String(MAX_PROVIDER_RESPONSE_BYTES + 1) } })),
      "content-length 超限未拒绝",
    ).rejects.toThrow()

    // 流式超限：无 content-length，按累计读取字节数拒绝
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_PROVIDER_RESPONSE_BYTES + 1))
        controller.close()
      },
    })
    const readOversized = async () => {
      const capped = await capProviderResponseBody(new Response(oversized))
      await capped.arrayBuffer()
    }
    await expect(readOversized(), "流式响应超限未拒绝").rejects.toThrow()

    // 消费者取消向上游传播，且首块必须增量交付（不能整段缓冲后再给）。
    let upstream: ReadableStreamDefaultController<Uint8Array> | undefined
    let cancelled = false
    const source = new ReadableStream<Uint8Array>({
      start(controller) { upstream = controller; controller.enqueue(new Uint8Array([1])) },
      cancel() { cancelled = true },
    })
    const guarded = await capProviderResponseBody(new Response(source))
    const reader = guarded.body!.getReader()
    const first = await reader.read()
    expect(first.value?.[0], "首块没有增量交付").toBe(1)
    await reader.cancel()
    expect(cancelled, "消费者取消未传播到上游").toBe(true)
    expect(upstream, "上游控制器不可见").toBeDefined()
  })
})
