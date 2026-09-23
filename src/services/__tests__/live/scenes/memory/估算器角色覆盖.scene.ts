import { ESTIMATE_DRIFT_WARN_RATIO, estimateMessageTokens } from "@/services/context"
import { PROMPT_SNAPSHOT_ENTRY } from "@/services/engine/pi"
import { initChat } from "@/services/agent/runner"
import { installFakeProvider, fakeText } from "../../fake-provider"
import { captureRuntimeTrace } from "../../trace-observer"
import { sessionEntries } from "../../session-entries"
import type { SceneDef } from "../../types"

// ── 场景口径：估算器覆盖全部消息角色 + 内容投影唯一 + tokenDrift 对账 ──
//
// 前四条是纯函数断言（不依赖模型）：上游的角色联合里 compactionSummary / branchSummary /
// bashExecution / custom 以前都按「只有 text/content 字符串」估成 0 或极小值 —— 摘要一多，
// 估算就系统性偏低，硬预算与压缩触发点都跟着漂。这里按角色表逐类钉住；
// 未知角色按整条估算并留痕（不静默退化成空串）。
//
// 第五条是真实回执：一轮 runtime 回合后从落盘的 provider_usage 快照取 tokenDrift，
// 与 trace 的 driftRatio 核对 —— 估算偏差只留痕，不改变任何预算判定。
const SUMMARY_BODY = "这是一段用于估算器角色覆盖断言的中文摘要正文，".repeat(18)   // ≈414 字符
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

let trace: ReturnType<typeof captureRuntimeTrace> | undefined

export const 估算器角色覆盖: SceneDef = {
  meta: {
    caseId: "memory-estimator-role-coverage",
    module: "memory",
    contractId: "mm-26",
    description: "估算器按角色表覆盖摘要类与自定义消息，未知角色不静默漏算，provider_usage 快照与 trace 记录估算偏差",
    depth: "deep",
    suite: "regression",
    entry: "runtime",
    tags: ["memory", "context", "budget"],
  },
  setup: async () => {
    trace = captureRuntimeTrace()
    installFakeProvider([fakeText(FAKE_REPLY)])
    await initChat()
  },
  turns: [{
    index: 1,
    description: "角色覆盖与内容投影的纯函数断言，以及真实回合里的 tokenDrift 对账",
    userText: "请简短回复。",
    checks: [
      { type: "expectRoleCoverage", run: async () => {
        const compaction = estimateMessageTokens({ role: "compactionSummary", summary: SUMMARY_BODY, tokensBefore: 1000, timestamp: 1 })
        const user = estimateMessageTokens(userLike(SUMMARY_BODY))
        if (ratioOf(compaction, user) > 1.10) {
          throw new Error(`compactionSummary 不再按 summary 正文估算：${compaction} vs user ${user}（正文 ${SUMMARY_BODY.length} 字符）`)
        }
        const branch = estimateMessageTokens({ role: "branchSummary", summary: SUMMARY_BODY, fromId: "x", timestamp: 1 })
        if (branch < user * 0.9) {
          throw new Error(`branchSummary 不再按 summary 正文估算：${branch} vs user ${user}（正文 ${SUMMARY_BODY.length} 字符）`)
        }
        const custom = estimateMessageTokens({ role: "custom", customType: "deskpet.active_message", content: SUMMARY_BODY, display: false, timestamp: 1 })
        if (custom <= 0) throw new Error("custom 消息被估成 0（主动消息进了请求却不计费）")
        const bash = { role: "bashExecution", command: "echo hi", output: "hi", exitCode: 0, cancelled: false, truncated: false, timestamp: 1 }
        if (estimateMessageTokens(bash) <= 0) throw new Error("bashExecution 被估成 0")
        // 与 convertToLlm 的排除一致：显式排除出上下文的 bash 执行只余固定结构开销。
        if (estimateMessageTokens({ ...bash, excludeFromContext: true }) !== 8) {
          throw new Error(`excludeFromContext 的 bash 执行没有按 0 正文计：${estimateMessageTokens({ ...bash, excludeFromContext: true })}`)
        }
        // 未知角色（上游新增）按整条估算，绝不留白。
        if (estimateMessageTokens({ role: "futureRole", content: "abc".repeat(40), timestamp: 1 }) <= estimateMessageTokens(userLike(""))) {
          throw new Error("未知角色被估成空串（新角色会静默漏算）")
        }
      } },
      { type: "expectTokenDrift", run: async () => {
        const entries = await sessionEntries()
        const usageSnapshots = entries
          .filter(entry => entry.type === "custom" && entry.customType === PROMPT_SNAPSHOT_ENTRY)
          .map(entry => (entry as { data?: SnapshotData }).data)
          .filter((data): data is SnapshotData => data?.captureStage === "provider_usage")
        if (usageSnapshots.length === 0) throw new Error("真实回合没有落盘 provider_usage 快照")
        const snapshot = usageSnapshots[usageSnapshots.length - 1]!
        const drift = snapshot.tokenDrift
        const estimated = snapshot.estimatedInputTokens
        const actual = snapshot.actualInputTokens
        if (!drift || typeof drift.estimated !== "number" || typeof drift.actual !== "number" || typeof drift.ratio !== "number") {
          throw new Error(`provider_usage 快照缺少 tokenDrift：${JSON.stringify(snapshot.tokenDrift ?? null)}（估算 ${String(estimated)}、usage ${String(actual)}）`)
        }
        if (drift.actual !== actual || drift.estimated !== estimated) {
          throw new Error(`tokenDrift 与快照字段不一致：drift=${JSON.stringify(drift)}、快照 estimated=${String(estimated)} actual=${String(actual)}`)
        }
        if (Math.abs(drift.ratio - (estimated as number) / (actual as number)) > 1e-6) {
          throw new Error(`tokenDrift.ratio 与 estimated/actual 不一致：${drift.ratio}`)
        }
        // trace 与快照带的是同一个值：超阈值才带 driftRatio，没超就两边都缺省。
        const traceUsage = (trace?.events ?? []).filter(event => event.kind === "provider_usage")
        if (traceUsage.length === 0) throw new Error("trace 里没有 provider_usage 事件")
        const driftRatio = traceUsage[traceUsage.length - 1]!.payload.driftRatio
        if (drift.ratio > ESTIMATE_DRIFT_WARN_RATIO) {
          if (driftRatio !== drift.ratio) {
            throw new Error(`偏差 ${drift.ratio} 超过阈值 ${ESTIMATE_DRIFT_WARN_RATIO}，trace 未带出同一个 driftRatio：${JSON.stringify(driftRatio ?? null)}`)
          }
        } else if (driftRatio !== undefined) {
          throw new Error(`偏差 ${drift.ratio} 未超阈值，trace 不该带 driftRatio：${JSON.stringify(driftRatio)}`)
        }
        trace?.unsubscribe()
      } },
    ],
  }],
}

export default 估算器角色覆盖
