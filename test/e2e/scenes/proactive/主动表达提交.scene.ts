import type { Entry } from "@earendil-works/pi-agent-core"
import { captureProactiveOwner, initChat, sendActiveMessage } from "@/services/agent/runner"
import { readActiveAttemptEvidence } from "@/services/engine/harness"
import * as proactiveIpc from "@/services/proactive/ipc"
import { nextProactiveQuotaDay } from "./quota-day"
import { readReceipt } from "@/services/proactive"
import { registerActiveReceiptReader } from "@/services/session"
import { getActiveCard } from "@/services/personality"
import { accountedUsage } from "@/services/proactive/usage"
import { getActiveSessionId } from "@/services/session/store"
import { fakeText, installFakeProvider } from "../../../host/fake-provider"
import { sessionEntries, sessionMessages } from "../../../host/session-entries"
import type { SceneDef } from "../../types"
import type { ActiveMessageResult, ActiveExpressionReservation } from "@/services/agent/types"
import type { ProactiveOwner } from "@/services/agent/types"

const INTENT = "基于已批准线索生成一次主动陪伴表达。"
const NEXT_USER_TURN = "继续正常对话。"
let provider: ReturnType<typeof installFakeProvider> | undefined
let result: ActiveMessageResult | undefined
let committedResult: Extract<ActiveMessageResult, { status: "committed" }> | undefined
let reservation: ActiveExpressionReservation | undefined
let sessionId = ""
let committedOwner: ProactiveOwner | undefined

function messageEntries(entries: readonly Entry[]) {
  return entries.filter((entry): entry is Extract<Entry, { type: "message" }> => entry.type === "message")
}

export const 主动表达提交: SceneDef = {
  meta: {
    caseId: "proactive-expression-native-commit",
    module: "proactive",
    contractId: "pr-05",
    description: "主动表达通过真实 Harness 与 Rust SQLite claim/validate/settle，JSONL operation tip 与已确认回执精确对应并进入会话视图",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["proactive", "commit", "receipt", "no-tools"],
  },
  setup: async () => {
    // The headless L4 host does not execute initApp; install the same SQLite-backed reader that production init wires.
    registerActiveReceiptReader(readReceipt)
    provider = installFakeProvider([fakeText("这是一次受控的主动表达。"), fakeText("普通回合仍然可用。")])
    await initChat()
    sessionId = getActiveSessionId()
    const owner = await captureProactiveOwner()
    if (!owner) throw new Error("主动表达没有可用的真实 session/Card owner")
    const now = Date.now()
    // 每个 setup 独立记账日（产品每日配额按 localDate 共享防打扰，见 quota-day.ts）；
    // occurrence 指纹同理用全新值：已 committed 的 occurrence 会被拒绝重复 claim，
    // 固定值会让 repeat>1 的后续 trial 拿不到 claim 而 ACTIVE_NO_COMMIT。
    const localDate = nextProactiveQuotaDay()
    const fingerprint = `l4-card-expression:${owner.cardId}:${owner.cardHash}:${crypto.randomUUID()}`
    const sourceRefs = [{ kind: "card" as const, id: owner.cardId, version: 1, revision: 1,
      scope: "card" as const, scopeId: owner.cardId, fingerprint: owner.cardHash, validUntil: now + 60_000 }]
    // Real IPC scan registers the source and supplies the SQLite source/control revisions used by claim.
    const scan = await proactiveIpc.scan({ owner, now, localDate, limit: 1, sourceRefs })
    const attemptId = crypto.randomUUID(), requestId = crypto.randomUUID()
    let claimed = false
    result = await sendActiveMessage({
    expectsReply: true,
      text: INTENT, owner, requestId, attemptId, ruleId: "l4_card_expression", intent: "l4_card_expression",
      sourceRefs, memoryTargets: [], occurrenceIds: [fingerprint],
      beforeGenerate: async (actualOwner, budget) => {
        // Keep the generation assigned by the real Harness for the later SQLite receipt query.
        committedOwner = actualOwner
        reservation = budget
        if (budget.toolCount !== 0 || budget.estimatedInputTokens > budget.hardInputLimit
          || budget.estimatedInputTokens + budget.maxOutputTokens > budget.contextWindow) return false
        const claim = await proactiveIpc.claim({ attemptId, requestId, kind: "expression", owner: actualOwner,
          sourceRefs, sourceFingerprint: fingerprint, sourceRevision: scan.sourceRevision,
          controlRevision: scan.control.revision, occurrenceIds: [fingerprint], now: Date.now(), localDate,
          reservedTokens: budget.estimatedInputTokens + budget.maxOutputTokens, ruleId: "l4_card_expression" })
        claimed = claim.claimed
        return claimed
      },
      // `sendActiveMessage` checks owner freshness before `beforeGenerate` performs
      // the SQLite claim. Claim validity is rechecked by `settle` after generation.
      isCurrent: async actualOwner => actualOwner.sessionId === sessionId
        && getActiveSessionId() === actualOwner.sessionId
        && getActiveCard()?.id === actualOwner.cardId && getActiveCard()?.hash === actualOwner.cardHash,
      settle: async (actualOwner, proof) => {
        const validation = await proactiveIpc.validate({ attemptId, owner: actualOwner, now: Date.now() })
        if (!validation.valid) return "stale"
        const receipt = await proactiveIpc.settle({ attemptId, owner: actualOwner, sourceFingerprint: fingerprint,
          localDate, status: "committed", assistantEntryId: proof.assistantEntryId,
          usage: accountedUsage(proof.usage), decision: { kind: "speak_now", ruleId: "l4_card_expression", opportunityFingerprints: [fingerprint],
            topicKey: null, slot: localDate, validUntil: now + 60_000 } })
        return receipt.status === "committed" ? "committed" : "unresolved"
      },
    })
    if (result.status !== "committed") throw new Error(`主动表达没有核实为已提交: ${JSON.stringify(result)}`)
    committedResult = result
  },
  turns: [{
    index: 1,
    description: "核对主动表达证据并确认后续普通用户回合正常",
    userText: NEXT_USER_TURN,
    checks: [{
      type: "expectActiveExpressionNativeCommitAndReadonlyReceipt",
      run: async () => {
        if (!provider || !result || result.status !== "committed") throw new Error("setup 没有形成主动提交证据")
        if (!reservation || reservation.toolCount !== 0 || reservation.maxOutputTokens < 1
          || reservation.estimatedInputTokens < 1 || reservation.hardInputLimit >= reservation.contextWindow) {
          throw new Error(`scheduler 收到的请求预算不是已准备的无工具请求视图: ${JSON.stringify(reservation)}`)
        }
        const activePayload = provider.payloads[0]
        if (!activePayload || (activePayload.tools ?? []).length !== 0) throw new Error("主动表达 Provider 请求宣告了工具")
        if (provider.payloads.length !== 2) throw new Error(`一次主动表达 + 一次普通回合应恰好两次 Provider 调用，实际 ${provider.payloads.length}`)

        const committed = committedResult
        if (!committed) throw new Error("主动表达提交结果在核验前丢失")
        const proof = await readActiveAttemptEvidence(sessionId, committed.attemptId, committed.requestId)
        if (!proof || proof.operationId !== committed.evidence.operationId
          || proof.triggerEntryId !== committed.evidence.triggerEntryId
          || proof.assistantEntryId !== committed.assistantEntryId || proof.text !== committed.text) {
          throw new Error("只读核验没有从 native operation 和 JSONL assistant tip 重建同一回执")
        }
        const entries = messageEntries(await sessionEntries(sessionId))
        const trigger = entries.find(entry => entry.id === proof.triggerEntryId)
        const assistant = entries.find(entry => entry.id === proof.assistantEntryId)
        if (!trigger || trigger.message.role !== "custom" || trigger.message.customType !== "deskpet.active_message") {
          throw new Error("提交证据没有绑定到主动意图自定义条目")
        }
        if (!assistant || assistant.message.role !== "assistant" || assistant.message.stopReason === "error") {
          throw new Error("native operation tip 不是成功提交的 assistant 条目")
        }
        if (entries.some(entry => entry.message.role === "toolResult")) throw new Error("主动表达运行了工具")
        if (!committedOwner) throw new Error("没有捕获到真实 Harness run generation")
        const receipt = await proactiveIpc.query({ owner: committedOwner, sessionId, attemptIds: [committed.attemptId], limit: 1 })
        const attempt = receipt.attempts.find(item => item.attemptId === committed.attemptId)
        if (attempt?.status !== "committed" || attempt.assistantEntryId !== proof.assistantEntryId) {
          throw new Error("SQLite receipt 没有精确确认同一 attempt 与 native assistant entry")
        }
        const view = await sessionMessages(sessionId)
        if (!view.some(message => message.id === proof.assistantEntryId && message.text === proof.text)) {
          throw new Error("经 SQLite 确认的主动结果没有进入会话读模型")
        }
        provider.restore()
      },
    }],
  }],
}

export default 主动表达提交
