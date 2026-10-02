// ==========================================
// 估算器角色覆盖 —— 从 test/e2e/scenes/memory/估算器角色覆盖.scene.ts 迁到 L3
// ==========================================
//
// 被测：估算器的角色表覆盖全部消息角色（摘要类按 summary 正文计费、未知角色按整条估算），
// 以及一轮真实回合后 provider_usage 快照与 trace 的 tokenDrift 对账。
//
// 归属 L3（不是 L2）的理由：第二条断言必须走真实 agent loop（fake Provider 只替换 Provider），
// 估算偏差要落在真实回合落盘的快照与 trace 上。
//
// 归 L3 的 import 判据：场景 import `@/services/engine/harness`（PROMPT_SNAPSHOT_ENTRY）。
//
// 审视结论（修正后搬，两条线索都已复核）：
//   ① `:59` D1：compactionSummary 只有上界（`ratio > 1.10`），正文估成 0 时比值 0 照样通过
//      —— 补下界（0 立刻红），让「按 summary 正文档计费」正反两个方向都可判。
//   ② `:71` D4：`!== 8` 抄实现常数 MESSAGE_STRUCTURE_TOKENS（改常数即假红，也不证明正文没计费）
//      —— 换成「正文长度从 2 字符到 5000 字符，excludeFromContext 的估计必须一模一样」，
//      并以「未排除的同一条更长」作对照，不抄常数、直接证明正文被排除。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { initPaths } from "@/services/paths"
import { fakeText, installFakeProvider } from "../../host/fake-provider"
import { captureRuntimeTrace } from "../../host/trace-observer"
import { sessionEntries } from "../../host/session-entries"
import { runRuntimeTurn } from "./回合夹具"
import { ESTIMATE_DRIFT_WARN_RATIO, estimateMessageTokens } from "@/services/context"
import { PROMPT_SNAPSHOT_ENTRY } from "@/services/engine/harness"

/** ≈414 字符的中文摘要正文：估算口径是「1 汉字 ≈ 1 token」，够大才断得出漏算。 */
const SUMMARY_BODY = "这是一段用于估算器角色覆盖断言的中文摘要正文，".repeat(18)
const FAKE_REPLY = "估算器角色覆盖完成"

const userLike = (text: string) => ({ role: "user", content: text, timestamp: 1 })

/** 估算比：压缩摘要正文与等价 user 文本的估算之比（框架开销落在这里）。 */
const ratioOf = (a: number, b: number) => a / b

interface SnapshotData {
  captureStage?: unknown
  estimatedInputTokens?: unknown
  actualInputTokens?: unknown
  tokenDrift?: { estimated?: unknown; actual?: unknown; ratio?: unknown }
}

let root = ""

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-memory-estimator-"))
  setTestDataRoot(root)
  // 路径模块是单例缓存（initPaths 幂等）：一个文件内固定一个数据根，测试之间靠
  // 会话/记忆服务的状态重置隔离，不再换根。
  await initPaths()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("估算器角色覆盖", () => {
  it("按角色表覆盖摘要类与自定义消息，未知角色不静默漏算，provider_usage 快照与 trace 记录估算偏差 [memory-estimator-role-coverage]", async () => {
    const trace = captureRuntimeTrace()
    try {
      installFakeProvider([fakeText(FAKE_REPLY)])
      await runRuntimeTurn("请简短回复。")

      // ── 角色覆盖与内容投影（纯函数断言）──
      const compaction = estimateMessageTokens({ role: "compactionSummary", summary: SUMMARY_BODY, tokensBefore: 1000, timestamp: 1 })
      const user = estimateMessageTokens(userLike(SUMMARY_BODY))
      // 价值钉的两端：正文估成 0 时比值 ≈ 0（上界放行），所以下界才是「真的按正文计费」的见证。
      expect(ratioOf(compaction, user), `compactionSummary 正文被估成 0 或极小值：${compaction} vs user ${user}（正文 ${SUMMARY_BODY.length} 字符）`)
        .toBeGreaterThanOrEqual(0.9)
      expect(ratioOf(compaction, user), `compactionSummary 不再按 summary 正文估算：${compaction} vs user ${user}（正文 ${SUMMARY_BODY.length} 字符）`)
        .toBeLessThanOrEqual(1.10)

      const branch = estimateMessageTokens({ role: "branchSummary", summary: SUMMARY_BODY, fromId: "x", timestamp: 1 })
      expect(branch, `branchSummary 不再按 summary 正文估算：${branch} vs user ${user}（正文 ${SUMMARY_BODY.length} 字符）`)
        .toBeGreaterThanOrEqual(user * 0.9)

      const custom = estimateMessageTokens({ role: "custom", customType: "deskpet.active_message", content: SUMMARY_BODY, display: false, timestamp: 1 })
      expect(custom, "custom 消息被估成 0（主动消息进了请求却不计费）").toBeGreaterThan(0)
      const bash = { role: "bashExecution", command: "echo hi", output: "hi", exitCode: 0, cancelled: false, truncated: false, timestamp: 1 }
      expect(estimateMessageTokens(bash), "bashExecution 被估成 0").toBeGreaterThan(0)
      // 与 convertToLlm 的排除一致：显式排除出上下文的 bash 执行只余固定结构开销。
      // 不抄结构开销常数：正文长度差 2500 倍而估计必须逐字相等，才证明计的是结构而不是正文。
      const excludedShort = estimateMessageTokens({ ...bash, excludeFromContext: true })
      const longBash = { ...bash, output: "x".repeat(5000) }
      const excludedLong = estimateMessageTokens({ ...longBash, excludeFromContext: true })
      expect(excludedLong, `excludeFromContext 的 bash 执行仍在按正文计费：${excludedShort} → ${excludedLong}`).toBe(excludedShort)
      // 对照：同一条正文没被排除时估计更大 —— 证明上面相等的两支确实「本可以按正文计费」。
      expect(excludedLong, "未排除的 bash 执行没有按正文计费（排除与不排除无差别）")
        .toBeLessThan(estimateMessageTokens(longBash))
      // 未知角色（上游新增）按整条估算，绝不留白。
      expect(estimateMessageTokens({ role: "futureRole", content: "abc".repeat(40), timestamp: 1 }), "未知角色被估成空串（新角色会静默漏算）")
        .toBeGreaterThan(estimateMessageTokens(userLike("")))

      // ── 真实回合的 tokenDrift 对账 ──
      const entries = await sessionEntries()
      const usageSnapshots = entries
        .filter(entry => entry.type === "custom" && entry.customType === PROMPT_SNAPSHOT_ENTRY)
        .map(entry => (entry as { data?: SnapshotData }).data)
        .filter((data): data is SnapshotData => data?.captureStage === "provider_usage")
      expect(usageSnapshots.length, "真实回合没有落盘 provider_usage 快照").toBeGreaterThan(0)
      const snapshot = usageSnapshots[usageSnapshots.length - 1]!
      const drift = snapshot.tokenDrift
      const estimated = snapshot.estimatedInputTokens
      const actual = snapshot.actualInputTokens
      expect(
        typeof drift?.estimated === "number" && typeof drift?.actual === "number" && typeof drift?.ratio === "number",
        `provider_usage 快照缺少 tokenDrift：${JSON.stringify(snapshot.tokenDrift ?? null)}（估算 ${String(estimated)}、usage ${String(actual)}）`,
      ).toBe(true)
      expect(drift, `tokenDrift 与快照字段不一致：drift=${JSON.stringify(drift)}、快照 estimated=${String(estimated)} actual=${String(actual)}`)
        .toMatchObject({ estimated, actual })
      // `expect` 不窄化类型，先把上面已断言过形态的字段取出来。
      const driftRatioValue = drift!.ratio as number
      const driftEstimated = drift!.estimated as number
      const driftActual = drift!.actual as number
      expect(Math.abs(driftRatioValue - driftEstimated / driftActual), `tokenDrift.ratio 与 estimated/actual 不一致：${driftRatioValue}`)
        .toBeLessThanOrEqual(1e-6)
      // trace 与快照带的是同一个值：超阈值才带 driftRatio，没超就两边都缺省。
      const traceUsage = trace.events.filter(event => event.kind === "provider_usage")
      expect(traceUsage.length, "trace 里没有 provider_usage 事件").toBeGreaterThan(0)
      const driftRatio = traceUsage[traceUsage.length - 1]!.payload.driftRatio
      if (driftRatioValue > ESTIMATE_DRIFT_WARN_RATIO) {
        expect(driftRatio, `偏差 ${driftRatioValue} 超过阈值 ${ESTIMATE_DRIFT_WARN_RATIO}，trace 未带出同一个 driftRatio：${JSON.stringify(driftRatio ?? null)}`)
          .toBe(driftRatioValue)
      } else {
        expect(driftRatio, `偏差 ${driftRatioValue} 未超阈值，trace 不该带 driftRatio：${JSON.stringify(driftRatio)}`).toBeUndefined()
      }
    } finally {
      trace.unsubscribe()
    }
  })
})
