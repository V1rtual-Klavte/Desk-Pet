import type { Entry } from "@earendil-works/pi-agent-core"
import { captureProactiveOwner, initChat, sendActiveMessage } from "@/services/agent/runner"
import { getActiveCard } from "@/services/personality"
import * as proactiveIpc from "@/services/proactive/ipc"
import { nextProactiveQuotaDay } from "./quota-day"
import { getActiveSessionId } from "@/services/session/store"
import { fakeText, installFakeProvider } from "../../../host/fake-provider"
import { sessionEntries } from "../../../host/session-entries"
import type { SceneDef } from "../../types"
import type { ActiveMessageResult } from "@/services/agent/types"
import type { ProactiveOwner } from "@/services/agent/types"

let provider: ReturnType<typeof installFakeProvider> | undefined
let deniedResult: ActiveMessageResult | undefined
let owner: ProactiveOwner | undefined
let attemptId = ""
let requestId = ""
let sourceFingerprint = ""
let sourceRefs: Array<{ kind: "card"; id: string; version: number; revision: number; scope: "card"; scopeId: string; fingerprint: string; validUntil: number }> = []
let scanState: Awaited<ReturnType<typeof proactiveIpc.scan>> | undefined
let before: Entry[] = []
let afterGuards: Entry[] = []
let sessionId = ""

export const 主动表达准入守卫: SceneDef = {
  meta: {
    caseId: "proactive-expression-admission-guard",
    module: "proactive",
    contractId: "pr-06",
    description: "真实 SQLite 已占用的 attempt 再次 claim 会在 Provider 前被拒绝，不调用模型且不产生 assistant 提交",
    depth: "deep",
    suite: "safety",
    entry: "production",
    tags: ["proactive", "owner-guard", "admission", "no-provider", "boundary", "error"],
  },
  setup: async () => {
    provider = installFakeProvider([fakeText("守卫失效后不应看到此回复。"), fakeText("普通用户回合仍能继续。")])
    await initChat()
    sessionId = getActiveSessionId()
    before = await sessionEntries(sessionId)
    owner = await captureProactiveOwner()
    if (!owner) throw new Error("准入守卫场景没有真实会话/Card owner")
    const now = Date.now()
    // 每个 setup 独立记账日（产品每日配额按 localDate 共享防打扰，见 quota-day.ts）；
    // occurrence 指纹同理用全新值：已 settle 的 occurrence 会被冷却守卫拒绝重复 claim
    // （正是本场景验证的行为），固定值会让 repeat>1 的后续 trial 卡在 setup。
    const localDate = nextProactiveQuotaDay()
    sourceFingerprint = `l4-duplicate-claim:${owner.cardId}:${owner.cardHash}:${crypto.randomUUID()}`
    sourceRefs = [{ kind: "card", id: owner.cardId, version: 1, revision: 1, scope: "card", scopeId: owner.cardId,
      fingerprint: owner.cardHash, validUntil: now + 60_000 }]
    scanState = await proactiveIpc.scan({ owner, now, localDate, limit: 1, sourceRefs })
    attemptId = crypto.randomUUID(); requestId = crypto.randomUUID()
    const initialClaim = await proactiveIpc.claim({ attemptId, requestId, kind: "expression", owner, sourceRefs,
      sourceFingerprint, sourceRevision: scanState.sourceRevision, controlRevision: scanState.control.revision,
      occurrenceIds: [sourceFingerprint], now, localDate, reservedTokens: 1, ruleId: "l4_duplicate_claim" })
    if (!initialClaim.claimed) throw new Error(`真实 SQLite 初始 claim 未成功: ${initialClaim.reason}`)
    deniedResult = await sendActiveMessage({
    expectsReply: true,
      text: "重复 claim 必须在 Provider 前拒绝。", owner, requestId, attemptId, ruleId: "l4_duplicate_claim",
      intent: "l4_duplicate_claim", sourceRefs, memoryTargets: [], occurrenceIds: [sourceFingerprint],
      beforeGenerate: async (actualOwner, reservation) => {
        if (reservation.toolCount !== 0 || reservation.estimatedInputTokens > reservation.hardInputLimit
          || reservation.estimatedInputTokens + reservation.maxOutputTokens > reservation.contextWindow) return false
        const duplicate = await proactiveIpc.claim({ attemptId, requestId, kind: "expression", owner: actualOwner,
          sourceRefs, sourceFingerprint, sourceRevision: scanState!.sourceRevision,
          controlRevision: scanState!.control.revision, occurrenceIds: [sourceFingerprint], now: Date.now(), localDate,
          reservedTokens: reservation.estimatedInputTokens + reservation.maxOutputTokens, ruleId: "l4_duplicate_claim" })
        return duplicate.claimed
      },
      isCurrent: async actualOwner => actualOwner.sessionId === getActiveSessionId()
        && getActiveCard()?.id === actualOwner.cardId && getActiveCard()?.hash === actualOwner.cardHash,
      settle: async () => "unresolved",
    })
    await proactiveIpc.settle({ attemptId, owner, sourceFingerprint, localDate, status: "failed", decision: null,
      usage: null, errorCode: "DUPLICATE_CLAIM_SCENE" })
    if (provider.payloads.length !== 0) throw new Error("owner / scheduler guard 失效后仍调用了 Provider")
    afterGuards = await sessionEntries(sessionId)
  },
  turns: [{
    index: 1,
    description: "核对重复 attempt claim 被真实 IPC 拒绝且不产生主动助手回复",
    userText: "守卫检查后继续正常交谈。",
    checks: [{
      type: "expectInvalidatedActiveOwnerAndAdmissionDeniedBeforeProvider",
      run: async () => {
        if (!provider || !owner || !scanState || !deniedResult) throw new Error("setup 没有执行真实 SQLite duplicate-claim guard")
        if (deniedResult.status === "committed") throw new Error("scheduler 拒绝的主动意图报告为已提交")
        const afterSetup = afterGuards.filter(entry => !before.some(prior => prior.id === entry.id))
        const activeTriggers = afterSetup.filter(entry => entry.type === "message" && entry.message.role === "custom"
          && entry.message.customType === "deskpet.active_message")
        if (activeTriggers.length !== 1) {
          throw new Error(`实际 Harness 应只落一个被拒主动 trigger，实际 ${activeTriggers.length}`)
        }
        const successfulAssistants = afterSetup.filter(entry => entry.type === "message"
          && entry.message.role === "assistant"
          && entry.message.stopReason !== "error" && entry.message.stopReason !== "aborted")
        if (successfulAssistants.length > 0) {
          throw new Error(`guard 终止后出现成功 assistant 提交条目: ${successfulAssistants.map(entry => entry.id).join(",")}`)
        }
        if (provider.payloads.length !== 1) throw new Error(`只有本场景正常用户回合应调用一次 Provider，实际 ${provider.payloads.length}`)
        provider.restore()
      },
    }],
  }],
}

export default 主动表达准入守卫
