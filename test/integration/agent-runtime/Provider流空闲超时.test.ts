// L3: exercises the Provider fetch/body cancellation boundary with a fake HTTP stream.
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Model } from "@earendil-works/pi-ai"
import { piStream } from "@/services/engine/harness/model-gateway"
import { createProviderObservation } from "@/services/engine/harness/provider-observation"

const { fixtureConfig } = vi.hoisted(() => ({ fixtureConfig: {
  provider: "openai-compatible", endpoint: "https://pi-stream-idle.invalid", apiKey: "http-fixture-key",
  requireApiKey: true, model: "pi-stream-idle-model", contextMaxTokens: 65_536,
} }))
// Only configuration is an in-memory fixture. piStream, its fetch guard and the installed SDK stay real.
// Avoid configuration writes/retry timers: this test owns no runtime data directory.
vi.mock("@/services/config", async importOriginal => ({
  ...await importOriginal<typeof import("@/services/config")>(), aiConfig: fixtureConfig,
}))

const encoder = new TextEncoder()

// Explicit fictitious model; HTTP is replaced before the installed SDK is invoked.
// No catalog lookup or configured model/credential inheritance is used by the fixture.
function httpFixtureModel(endpoint: string, id: string): Model<"openai-completions"> {
  return { id, name: id, api: "openai-completions", provider: "openai-compatible", baseUrl: endpoint,
    reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 16,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
}

describe("Provider SSE 空闲超时", () => {
  afterEach(() => vi.useRealTimers())

  it("body 停滞时中止 Provider signal、取消底层响应并释放监听器 [provider-stream-idle-timeout-cancels-http]", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    let sourceCancelled = false
    const source = new ReadableStream<Uint8Array>({
      cancel() { sourceCancelled = true },
    })
    const fetchImpl = vi.fn(async () => new Response(source, {
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch
    const removeListener = vi.spyOn(controller.signal, "removeEventListener")
    const observation = createProviderObservation()
    const observedFetch = observation.fetch(fetchImpl, {
      signal: controller.signal,
      idleTimeoutMs: 25,
      onIdleTimeout: error => controller.abort(error),
    })
    const response = await observedFetch("https://provider.invalid/stream")
    const read = response.body!.getReader().read()
    const rejected = expect(read).rejects.toThrow("Provider 响应流连续 25ms 无数据")
    await vi.advanceTimersByTimeAsync(25)

    await rejected
    expect(controller.signal.aborted).toBe(true)
    expect(controller.signal.reason).toMatchObject({ name: "ProviderIdleTimeoutError" })
    expect(sourceCancelled).toBe(true)
    expect(observation.snapshot()).toEqual({ idleTimeout: true })
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
  })

  it("收到 SSE 心跳时刷新空闲窗口，正常结束后清除计时器 [provider-stream-heartbeat-refreshes-idle-timeout]", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    let sourceController!: ReadableStreamDefaultController<Uint8Array>
    const source = new ReadableStream<Uint8Array>({ start(value) { sourceController = value } })
    const observedFetch = createProviderObservation().fetch(async () => new Response(source, {
      headers: { "content-type": "text/event-stream" },
    }), {
      signal: controller.signal,
      idleTimeoutMs: 25,
      onIdleTimeout: error => controller.abort(error),
    })
    const response = await observedFetch("https://provider.invalid/stream")
    const reader = response.body!.getReader()

    const first = reader.read()
    await vi.advanceTimersByTimeAsync(15)
    sourceController.enqueue(encoder.encode(": keepalive\n\n"))
    await expect(first).resolves.toMatchObject({ done: false })

    const second = reader.read()
    await vi.advanceTimersByTimeAsync(15)
    expect(controller.signal.aborted).toBe(false)
    sourceController.enqueue(encoder.encode("data: [DONE]\n\n"))
    await expect(second).resolves.toMatchObject({ done: false })

    const finished = reader.read()
    sourceController.close()
    await expect(finished).resolves.toMatchObject({ done: true })
    await vi.advanceTimersByTimeAsync(30)
    expect(controller.signal.aborted).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("真实 piStream 经安装版 Pi SDK 收到 timeoutMs 与 abort，停滞 body 终结为 error [pi-stream-sdk-body-idle-timeout]", async () => {
    vi.useFakeTimers()
    const endpoint = fixtureConfig.endpoint
    let sourceCancelled = false
    let requestSignal: AbortSignal | undefined
    let resolveRequest!: () => void
    const requestStarted = new Promise<void>(resolve => { resolveRequest = resolve })
    let resolveBodyRead!: () => void
    const bodyReadStarted = new Promise<void>(resolve => { resolveBodyRead = resolve })
    const source = new ReadableStream<Uint8Array>({
      pull() { resolveBodyRead() },
      cancel() { sourceCancelled = true },
    })
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined
      resolveRequest()
      return new Response(source, { status: 200, headers: { "content-type": "text/event-stream" } })
    })

    try {
      const model = httpFixtureModel(endpoint, "pi-stream-idle-model")
      const caller = new AbortController()
      const removeListener = vi.spyOn(caller.signal, "removeEventListener")
      const stream = piStream(model, { systemPrompt: "Reply briefly.", messages: [] }, {
        signal: caller.signal,
        timeoutMs: 40,
        maxTokens: 16,
      })
      const result = stream.result()
      await requestStarted
      await bodyReadStarted
      await vi.advanceTimersByTimeAsync(40)
      const message = await result

      expect(message.stopReason).toBe("error")
      expect(message.errorMessage).toBe("Provider response stream made no progress before the idle deadline")
      expect(requestSignal?.aborted).toBe(true)
      // The installed OpenAI SDK forwards cancellation through its own controller;
      // it normalizes the HTTP signal reason to AbortError. Pi retains our diagnostic above.
      expect(requestSignal?.reason).toMatchObject({ name: "AbortError" })
      expect(sourceCancelled).toBe(true)
      expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function))
      // Drain the SDK/stream cancellation microtasks before checking retained timers.
      await vi.advanceTimersByTimeAsync(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("调用方取消仍归类为 aborted，并取消已建立的 Pi SDK HTTP 响应 [pi-stream-sdk-user-cancel-remains-aborted]", async () => {
    vi.useFakeTimers()
    let sourceCancelled = false
    let requestSignal: AbortSignal | undefined
    let resolveRequest!: () => void
    const requestStarted = new Promise<void>(resolve => { resolveRequest = resolve })
    let resolveBodyRead!: () => void
    const bodyReadStarted = new Promise<void>(resolve => { resolveBodyRead = resolve })
    const source = new ReadableStream<Uint8Array>({
      pull() { resolveBodyRead() },
      cancel() { sourceCancelled = true },
    })
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined
      resolveRequest()
      return new Response(source, { status: 200, headers: { "content-type": "text/event-stream" } })
    })

    try {
      const caller = new AbortController()
      const stream = piStream(httpFixtureModel(fixtureConfig.endpoint, fixtureConfig.model),
        { systemPrompt: "Reply briefly.", messages: [] }, {
        signal: caller.signal,
        timeoutMs: 1_000,
        maxTokens: 16,
      })
      const result = stream.result()
      await requestStarted
      await bodyReadStarted
      caller.abort(new Error("user stopped"))
      const message = await result

      expect(message.stopReason).toBe("aborted")
      expect(requestSignal?.aborted).toBe(true)
      expect(sourceCancelled).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
