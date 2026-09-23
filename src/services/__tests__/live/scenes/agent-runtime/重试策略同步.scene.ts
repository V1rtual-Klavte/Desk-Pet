import { fauxAssistantMessage } from "@earendil-works/pi-ai"
import { harnessSlots } from "@/services/engine/pi"
import type { HarnessSlot } from "@/services/engine/pi"
import { loopConfig, setOverride } from "@/services/config"
import { getActiveSessionId } from "@/services/session"
import { installFakeProvider } from "../../fake-provider"
import type { SceneDef } from "../../types"

// ── 场景口径：生成级重试策略按运行下发，不重开槽 ──
//
// 策略只在 `AgentHarness.create` 下发时，改设置页的 `ai.loop.maxRetry` 看起来生效、实际要重开
// 会话才起作用。这里在同一条运行槽上先跑 0 次重试、再跑 2 次重试：失败响应必须命中上游的可重试
// 文案（普通 error 文案不会触发重试），否则「重试不发生」会被误读成「策略没变」。

/** 命中上游可重试文案的服务端故障；写成不可重试的文案则重试永远不会发生。 */
const RETRYABLE_FAILURE = "503 Service Unavailable"
const DONE_TEXT = "重试后成功"

let provider: ReturnType<typeof installFakeProvider> | undefined
let previousMaxRetry = 0
let slotBefore: HarnessSlot | undefined
let callsAtFirstFailure = -1

export const 重试策略同步: SceneDef = {
  meta: {
    caseId: "memory-retry-policy-sync",
    module: "agent-runtime",
    contractId: "ar-18",
    description: "改 ai.loop.maxRetry 后同一运行槽在下一次 run 前收到新 RetryPolicy：不重开槽，重试次数按新值生效",
    depth: "deep",
    suite: "regression",
    entry: "runtime",
    tags: ["agent-runtime", "error"],
  },
  setup: async () => {
    previousMaxRetry = loopConfig.maxRetry
    setOverride("ai.loop.maxRetry", 0)
    provider = installFakeProvider([
      // 第 1 轮（maxRetry=0）：失败且不得重试。
      fauxAssistantMessage("", { stopReason: "error", errorMessage: RETRYABLE_FAILURE }),
      // 第 2 轮（maxRetry=2）：先失败、重试后成功。
      fauxAssistantMessage("", { stopReason: "error", errorMessage: RETRYABLE_FAILURE }),
      fauxAssistantMessage(DONE_TEXT),
    ])
  },
  turns: [
    {
      index: 1,
      description: "maxRetry=0：失败回合不产生任何重试",
      userText: "这轮一定会失败。",
      expectFailure: { kind: "provider", message: RETRYABLE_FAILURE },
      checks: [
        { type: "expectNoRetryAtZero", run: async context => {
          if (!context.output.failure) throw new Error("回合没有按失败结算")
          if (context.output.retriesUsed !== 0) throw new Error(`maxRetry=0 时仍发生了重试: ${context.output.retriesUsed}`)
          const calls = provider?.state.callCount ?? 0
          if (calls !== 1) throw new Error(`maxRetry=0 时请求了 ${calls} 次（应恰好 1 次）`)
          callsAtFirstFailure = calls
          // 同一槽的下一轮：策略在运行开始前下发，不得重开槽。
          slotBefore = harnessSlots.peek(getActiveSessionId())
          setOverride("ai.loop.maxRetry", 2)
        } },
      ],
    },
    {
      index: 2,
      description: "maxRetry=2：同一槽的下一轮按新策略重试并成功",
      userText: "这轮先失败再重试。",
      checks: [
        { type: "expectRetryAtTwo", run: async context => {
          if (context.output.retriesUsed < 1) throw new Error(`maxRetry=2 后没有发生重试: ${context.output.retriesUsed}`)
          if (callsAtFirstFailure !== 1) throw new Error("前一轮的调用计数基线不可信")
          const calls = provider?.state.callCount ?? 0
          if (calls !== callsAtFirstFailure + 2) {
            throw new Error(`第 2 轮应请求 2 次（一次失败 + 一次重试），实际 ${calls}`)
          }
          if (!context.output.reply.includes(DONE_TEXT)) throw new Error(`重试后没有采用成功响应: ${context.output.reply}`)
          if (harnessSlots.peek(getActiveSessionId()) !== slotBefore) {
            throw new Error("改重试策略后运行槽被重开（策略应按运行下发，不重开槽）")
          }
        } },
        // 结束还原：`ai.loop.maxRetry` 是跨场景配置，场景自己还原（standardSetup 的基线还原是兜底）。
        { type: "expectRetryPolicyRestored", run: async () => {
          setOverride("ai.loop.maxRetry", previousMaxRetry)
          if (loopConfig.maxRetry !== previousMaxRetry) throw new Error("重试配置没有还原")
        } },
      ],
    },
  ],
}

export default 重试策略同步
