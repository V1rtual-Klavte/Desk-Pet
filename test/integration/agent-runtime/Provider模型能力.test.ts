import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { aiConfig, setOverride } from "@/services/config"
import { completePiText } from "@/services/engine/harness/model-gateway"
import { createRuntimeTraceContext, subscribeRuntimeTrace } from "@/services/engine/runtime"

const ENDPOINT = "https://provider-capabilities.invalid"
const API_KEY = "provider-capabilities-test-key"
const RESPONSE_MODEL = "deepseek-wire-response-model"

type WirePayload = Record<string, unknown> & { model: string }

function sseResponse(cacheCount?: number): Response {
  const usage = cacheCount === undefined ? {} : { prompt_tokens_details: { cached_tokens: cacheCount } }
  const events = [
    `data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: RESPONSE_MODEL, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: RESPONSE_MODEL, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13, ...usage } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("")
  return new Response(events, { status: 200, headers: { "content-type": "text/event-stream" } })
}

let previous: {
  provider: string
  endpoint: string
  apiKey: string
  requireApiKey: boolean
  model: string
}

beforeEach(() => {
  previous = {
    provider: aiConfig.provider,
    endpoint: aiConfig.endpoint,
    apiKey: aiConfig.apiKey,
    requireApiKey: aiConfig.requireApiKey,
    model: aiConfig.model,
  }
})

function restoreConfigAndFetch(): void {
  setOverride("ai.provider", previous.provider)
  setOverride("ai.endpoint", previous.endpoint)
  setOverride("ai.apiKey", previous.apiKey)
  setOverride("ai.requireApiKey", previous.requireApiKey)
  setOverride("ai.model", previous.model)
  vi.unstubAllGlobals()
}

afterEach(restoreConfigAndFetch)

describe("Provider 模型能力网线行为", () => {
  it("保留官方模型 ID、推理档位与原始响应观测 [provider-model-wire-capabilities]", async () => {
    const payloads: WirePayload[] = []
    const unexpectedOrigins: string[] = []
    let cacheCount: number | undefined = 0
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      if (new URL(url).origin !== ENDPOINT) {
        unexpectedOrigins.push(new URL(url).origin)
        return sseResponse(cacheCount)
      }
      const body = typeof init?.body === "string" ? init.body : ""
      payloads.push(JSON.parse(body) as WirePayload)
      return sseResponse(cacheCount)
    })
    setOverride("ai.provider", "deepseek")
    setOverride("ai.endpoint", ENDPOINT)
    setOverride("ai.apiKey", API_KEY)
    setOverride("ai.requireApiKey", true)
    setOverride("ai.model", "deepseek-flash")

    const traceEvents: Array<{ kind: string; payload: Record<string, unknown> }> = []
    const unsubscribe = subscribeRuntimeTrace(event => { traceEvents.push(event) })
    try {
      const effortCases = [
        { effort: "low" as const, wireEffort: "low", thinking: "enabled" },
        // Flash 当前官方能力将 medium 收敛为 high。
        { effort: "medium" as const, wireEffort: "high", thinking: "enabled" },
        { effort: "high" as const, wireEffort: "high", thinking: "enabled" },
        { effort: "auto" as const, wireEffort: undefined, thinking: undefined },
      ]

      for (const [index, testCase] of effortCases.entries()) {
        cacheCount = index === 0 ? 0 : undefined
        const result = await completePiText({
          purpose: "memory",
          memoryStage: "rewrite",
          systemPrompt: "Return a short answer.",
          userText: `probe ${testCase.effort}`,
          thinkingEffort: testCase.effort,
          traceContext: createRuntimeTraceContext(undefined, `provider-capability-${index}`),
        })
        const payload = payloads[index]
        expect(payload.model).toBe("deepseek-flash")
        expect(payload.reasoning_effort).toBe(testCase.wireEffort)
        expect((payload.thinking as { type?: string } | undefined)?.type).toBe(testCase.thinking)
        expect(result.responseModel).toBe(RESPONSE_MODEL)
        expect(result.cacheUsageReported).toBe(index === 0 ? true : undefined)
      }

      setOverride("ai.model", "deepseek-v4-pro")
      cacheCount = undefined
      const pro = await completePiText({
        purpose: "memory",
        memoryStage: "rewrite",
        systemPrompt: "Return a short answer.",
        userText: "probe v4 pro low",
        thinkingEffort: "low",
        traceContext: createRuntimeTraceContext(undefined, "provider-capability-pro"),
      })
      const proPayload = payloads[4]
      expect(proPayload.model).toBe("deepseek-v4-pro")
      expect(proPayload.reasoning_effort).toBe("low")
      expect((proPayload.thinking as { type?: string } | undefined)?.type).toBe("enabled")
      expect(pro.responseModel).toBe(RESPONSE_MODEL)
      expect(pro.cacheUsageReported).toBeUndefined()

      const endEvents = traceEvents.filter(event => event.kind === "provider_request_end")
      expect(endEvents).toHaveLength(5)
      const traced = endEvents[0].payload
      expect(traced.memoryStage).toBe("rewrite")
      expect(traced.model).toBe("deepseek-flash")
      expect(traced.responseModel).toBe(RESPONSE_MODEL)
      expect(traced.cacheUsageReported).toBe(true)
      expect(traced.reasoningEffort).toBe("low")
      expect(traced.thinkingMode).toBe("enabled")
      expect(JSON.stringify(traceEvents)).not.toContain(API_KEY)
      expect(JSON.stringify(traceEvents)).not.toContain("Return a short answer")
      expect(unexpectedOrigins).toEqual([])
    } finally {
      unsubscribe()
      restoreConfigAndFetch()
    }
  })
})
