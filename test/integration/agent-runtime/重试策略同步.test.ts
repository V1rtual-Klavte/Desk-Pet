// ==========================================
// 重试策略同步 —— 从 test/e2e/scenes/agent-runtime/重试策略同步.scene.ts 迁到 L3（W3）
//
// 被测：生成级重试策略按运行下发，不重开槽 —— 改 `ai.loop.maxRetry` 后，同一运行槽在
// 下一次 run 开始前收到新 RetryPolicy。策略只在 `AgentHarness.create` 下发时，改设置页看似
// 生效、实际要重开会话才起作用；这条路径由本用例钉住。
//
// 归 L3 的理由（按 import 判定 + 实测）：场景 import `@/services/engine/pi`（HarnessSlot /
// 运行内核与测试 provider 装载点），命中规则 6 的 L2 禁入清单；实测在 Node 适配层下两回合
// 全链路跑通（fake Provider 交付脚本，真实 agent loop、真实 JSONL 落盘）。
//
// 迁移审视（W3，契约 agent-runtime 表未见本场景线索，自行判定）：
//   · 两条 check 的断言逐条保留 —— 失败结算（failure 分类与文案）、`retriesUsed`、
//     provider 请求计数、运行槽对象身份，四条都能被坏实现判红：策略不按运行下发 →
//     第 2 轮不重试（计数停在 2 且无成功回复）；maxRetry=0 被忽略 → 第 1 轮计数 2；
//     改配置即重开槽 → 槽身份比对红。全部照搬。
//   · 原第三条 check `expectRetryPolicyRestored` 是「还原配置 + 断言还原成功」，属 teardown
//     而非产品断言（产品改坏不会让它红），L3 移到 afterEach 还原，不作为断言搬运。
// ==========================================

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fauxAssistantMessage } from "@earendil-works/pi-ai"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { installFakeProvider } from "../../host/fake-provider"
import { setTestDataRoot } from "../../host/node-ipc"
import { standardSetup } from "../../host/standard-setup"
import { runRuntimeTurn } from "./_runtime-turn"
import { loopConfig, setOverride } from "@/services/config"
import { harnessSlots } from "@/services/engine/pi"
import { initPaths } from "@/services/paths"
import { getActiveSessionId } from "@/services/session/store"

/** 命中上游可重试文案的服务端故障；写成不可重试的文案则重试永远不会发生。 */
const RETRYABLE_FAILURE = "503 Service Unavailable"
const DONE_TEXT = "重试后成功"

let dataRoot = ""
let previousMaxRetry = 0

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), "deskpet-agent-runtime-retry-"))
  setTestDataRoot(dataRoot)
  await initPaths()
})

afterAll(() => {
  rmSync(dataRoot, { recursive: true, force: true })
})

beforeEach(async () => {
  // 与 L4 场景同一条隔离：standardSetup 复位配置基线 / 会话 / 运行槽 / 变量池 / 记忆。
  await standardSetup()
  previousMaxRetry = loopConfig.maxRetry
})

afterEach(() => {
  // 结束还原：`ai.loop.maxRetry` 是跨场景配置，测试自己还原（配置基线还原是兜底）。
  setOverride("ai.loop.maxRetry", previousMaxRetry)
})

describe("重试策略同步", () => {
  it("改 ai.loop.maxRetry 后同一运行槽在下一次 run 前收到新 RetryPolicy：不重开槽，重试次数按新值生效 [memory-retry-policy-sync]", async () => {
    setOverride("ai.loop.maxRetry", 0)
    const provider = installFakeProvider([
      // 第 1 轮（maxRetry=0）：失败且不得重试。
      fauxAssistantMessage("", { stopReason: "error", errorMessage: RETRYABLE_FAILURE }),
      // 第 2 轮（maxRetry=2）：先失败、重试后成功。
      fauxAssistantMessage("", { stopReason: "error", errorMessage: RETRYABLE_FAILURE }),
      fauxAssistantMessage(DONE_TEXT),
    ])

    // ── 第 1 轮：maxRetry=0 的失败回合不产生任何重试 ──
    const first = await runRuntimeTurn("这轮一定会失败。")
    expect(first.failure, `回合没有按失败结算: reply=${JSON.stringify(first.reply)}`).toBeDefined()
    expect(first.failure?.kind, `失败分类不是 provider: ${first.failure?.message ?? "(无失败)"}`).toBe("provider")
    expect(first.failure?.message, `失败文案不是可重试的服务端故障原文: ${first.failure?.message ?? "(无失败)"}`).toContain(RETRYABLE_FAILURE)
    expect(first.retriesUsed, `maxRetry=0 时仍发生了重试: ${first.retriesUsed}`).toBe(0)
    expect(provider.state.callCount, `maxRetry=0 时请求了 ${provider.state.callCount} 次（应恰好 1 次）`).toBe(1)

    const sessionId = getActiveSessionId()
    const slotBefore = harnessSlots.peek(sessionId)
    expect(slotBefore, "第 1 轮结束后会话没有运行槽").toBeDefined()

    // ── 同一槽的下一轮：改配置，策略在运行开始前下发，不得重开槽 ──
    setOverride("ai.loop.maxRetry", 2)
    const second = await runRuntimeTurn("这轮先失败再重试。")
    expect(second.failure, `maxRetry=2 后的回合仍以失败结束: ${second.failure?.message ?? "(无失败)"}`).toBeUndefined()
    expect(second.retriesUsed, `maxRetry=2 后没有发生重试: ${second.retriesUsed}`).toBeGreaterThanOrEqual(1)
    expect(provider.state.callCount, `第 2 轮应请求 2 次（一次失败 + 一次重试），实际 ${provider.state.callCount}`).toBe(3)
    expect(second.reply, `重试后没有采用成功响应: ${JSON.stringify(second.reply)}`).toContain(DONE_TEXT)
    expect(harnessSlots.peek(sessionId), "改重试策略后运行槽被重开（策略应按运行下发，不重开槽）").toBe(slotBefore)
  }, 60_000)
})
