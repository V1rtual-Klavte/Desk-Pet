// L3: exercises the fetch/Response stream boundary without contacting a provider.
import { describe, expect, it, vi } from "vitest"
import { createProviderObservation } from "@/services/engine/harness/provider-observation"

const encoder = new TextEncoder()

function streamResponse(chunks: string[], contentType = "text/event-stream"): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, { headers: { "content-type": contentType } })
}

function fetchStub(...responses: Response[]): typeof fetch {
  const queue = [...responses]
  return vi.fn(async () => {
    const response = queue.shift()
    if (!response) throw new Error("unexpected fetch")
    return response
  }) as unknown as typeof fetch
}

describe("Provider 响应 metadata 观测", () => {
  it("逐块解析 SSE 但将原始字节原样交给消费者 [provider-observation-sse-passthrough]", async () => {
    const chunks = [
      "data: {\"model\":\"deepseek-chat\",\"choices\":[{\"delta\":{\"content\":\"你好\"}}],",
      "\"usage\":{\"prompt_cache_hit_tokens\":0,\"prompt_cache_write_tokens\":12}}\r\n\r\n",
      "data: [DONE]\r\n\r\n",
    ]
    const sourceText = chunks.join("")
    const observation = createProviderObservation()
    const observedFetch = observation.fetch(fetchStub(streamResponse(chunks)))
    const response = await observedFetch("https://provider.invalid/v1/chat/completions")
    const returnedBytes = new Uint8Array(await response.arrayBuffer())

    expect(new TextDecoder().decode(returnedBytes)).toBe(sourceText)
    expect(observation.snapshot()).toEqual({ responseModel: "deepseek-chat", cacheUsageReported: true })
  })

  it("识别 non-stream JSON 中零值缓存字段的存在 [provider-observation-json-cache-presence]", async () => {
    const observation = createProviderObservation()
    const observedFetch = observation.fetch(fetchStub(streamResponse([
      JSON.stringify({ model: "gpt-compatible", usage: { prompt_tokens_details: { cached_tokens: 0 } } }),
    ], "application/json")))

    const response = await observedFetch("https://provider.invalid/v1/chat/completions")
    expect(await response.json()).toEqual({ model: "gpt-compatible", usage: { prompt_tokens_details: { cached_tokens: 0 } } })
    expect(observation.snapshot()).toEqual({ responseModel: "gpt-compatible", cacheUsageReported: true })

    const absentObservation = createProviderObservation()
    const absentFetch = absentObservation.fetch(fetchStub(streamResponse([
      JSON.stringify({ model: "gpt-compatible", usage: { prompt_tokens: 10 } }),
    ], "application/json")))
    await (await absentFetch("https://provider.invalid/v1/chat/completions")).arrayBuffer()
    expect(absentObservation.snapshot()).toEqual({ responseModel: "gpt-compatible" })

    const responsesObservation = createProviderObservation()
    const responsesFetch = responsesObservation.fetch(fetchStub(streamResponse([
      JSON.stringify({ response: { model: "gpt-responses", usage: { input_tokens_details: { cached_tokens: 4 } } } }),
    ], "application/json")))
    await (await responsesFetch("https://provider.invalid/v1/responses")).arrayBuffer()
    expect(responsesObservation.snapshot()).toEqual({ responseModel: "gpt-responses", cacheUsageReported: true })
  })

  it("只有缓存写入量或空缓存读取值不能证明读命中 [provider-observation-cache-write-is-unknown]", async () => {
    const observation = createProviderObservation()
    const observedFetch = observation.fetch(fetchStub(streamResponse([
      JSON.stringify({
        model: "deepseek-chat",
        usage: { prompt_cache_write_tokens: 32, prompt_cache_hit_tokens: null, prompt_tokens_details: { cached_tokens: null } },
      }),
    ], "application/json")))

    await (await observedFetch("https://provider.invalid/v1/chat/completions")).arrayBuffer()

    expect(observation.snapshot()).toEqual({ responseModel: "deepseek-chat" })
  })

  it("识别 Anthropic cache usage 字段，且相互冲突的响应模型视为未知 [provider-observation-model-conflict]", async () => {
    const observation = createProviderObservation()
    const observedFetch = observation.fetch(fetchStub(
      streamResponse(["data: {\"type\":\"message_start\",\"message\":{\"model\":\"model-a\",\"usage\":{\"cache_read_input_tokens\":0}}}\n\n"]),
      streamResponse(["data: {\"model\":\"model-b\",\"usage\":{\"cache_creation_input_tokens\":5}}\n\n"]),
    ))

    await (await observedFetch("https://provider.invalid/first")).arrayBuffer()
    await (await observedFetch("https://provider.invalid/second")).arrayBuffer()

    expect(observation.snapshot()).toEqual({ cacheUsageReported: true })
  })

  it("消费取消继续传给原始 Response body [provider-observation-cancel]", async () => {
    let cancelReason: unknown
    const upstreamBody = new ReadableStream<Uint8Array>({
      cancel(reason) { cancelReason = reason },
    })
    const observation = createProviderObservation()
    const observedFetch = observation.fetch(fetchStub(new Response(upstreamBody, {
      headers: { "content-type": "text/event-stream" },
    })))
    const response = await observedFetch("https://provider.invalid/stream")

    await response.body!.cancel("turn cancelled")

    expect(cancelReason).toBe("turn cancelled")
  })

  it("fetch 网络错误原样向消费方抛出且观测快照保持未知 [provider-observation-fetch-error]", async () => {
    const failure = new TypeError("upstream unavailable")
    const fetchImpl = vi.fn(async () => { throw failure }) as unknown as typeof fetch
    const observation = createProviderObservation()
    const observedFetch = observation.fetch(fetchImpl)

    await expect(observedFetch("https://provider.invalid/stream")).rejects.toBe(failure)
    expect(observation.snapshot()).toEqual({})
  })

  it("忽略超长单行后仍继续观察后续 SSE 帧而不影响响应正文 [provider-observation-bounded-buffer]", async () => {
    const oversized = `data: {"model":"must-not-be-kept","padding":"${"x".repeat(17 * 1024)}"}\n\n`
    const valid = "data: {\"model\":\"final-model\"}\n\n"
    const observation = createProviderObservation()
    const observedFetch = observation.fetch(fetchStub(streamResponse([oversized, valid])))
    const response = await observedFetch("https://provider.invalid/stream")
    const responseText = await response.text()

    expect(responseText).toBe(oversized + valid)
    expect(observation.snapshot()).toEqual({ responseModel: "final-model" })
  })
})
