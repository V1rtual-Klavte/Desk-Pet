import { PROMPT_SNAPSHOT_ENTRY, harnessSlots } from "@/services/engine/pi"
import { getActiveSessionId } from "@/services/session"
import { installFakeProvider, fakeText, fakeToolCall } from "../../fake-provider"
import { sessionEntries } from "../../session-entries"
import type { SceneDef } from "../../types"

// ── 场景口径：审计落盘闭环（三档快照各至少一条，且集合不因 flush / 释放槽而变） ──
//
// 审计条目只入队（hook 内写 lane 会死锁），落盘由唯一的 flush 入口在 lane 空闲时完成：
// 回合收尾、手动压缩收尾、槽关闭前，以及回合结算前对快照任务的那一次补 flush。
// 这个场景把「证据链的组成项不会在槽生命周期结束时静默消失」钉在真实 production 回合上：
// 一轮工具调用会让 transform_context / provider_payload / provider_usage 三档快照都产生。
const SNAPSHOTS = PROMPT_SNAPSHOT_ENTRY

let provider: ReturnType<typeof installFakeProvider> | undefined

/** 快照条目的 id 与 captureStage：集合断言只看 id，档位断言看 data.captureStage。 */
async function snapshotEntries(sessionId: string): Promise<Array<{ id: string; captureStage: string }>> {
  const entries = await sessionEntries(sessionId)
  return entries.flatMap(entry => entry.type === "custom" && entry.customType === SNAPSHOTS
    ? [{ id: entry.id, captureStage: String((entry.data as { captureStage?: unknown } | undefined)?.captureStage ?? "") }]
    : [])
}

const idsOf = (entries: Array<{ id: string }>) => entries.map(entry => entry.id).sort().join(",")

export const 审计闭环: SceneDef = {
  meta: {
    caseId: "memory-snapshot-audit-closure",
    module: "memory",
    contractId: "mm-24",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["memory", "snapshot", "production-entry"],
  },
  setup: async () => {
    provider = installFakeProvider([fakeToolCall("system_info", {}, "audit-call"), fakeText("审计闭环完成")])
    await initChat()
  },
  turns: [{
    index: 1,
    description: "一轮带工具调用的 production 回合：三档快照落盘，flush 与释放槽都不改变集合",
    userText: "先调用 system_info，再回复。",
    checks: [
      { type: "expectAuditStages", run: async (context) => {
        if (!context.toolHistory.some(item => item.toolName === "system_info" && item.status === "done")) {
          throw new Error(`工具没有真实执行，三档快照的前提不成立：${JSON.stringify(context.toolHistory)}`)
        }
        if ((provider?.state.callCount ?? 0) < 2) throw new Error("fake provider 未完成工具后续回合")
        const sessionId = getActiveSessionId()
        const before = await snapshotEntries(sessionId)
        for (const stage of ["transform_context", "provider_payload", "provider_usage"]) {
          if (!before.some(entry => entry.captureStage === stage)) {
            throw new Error(`缺少 ${stage} 档快照：${JSON.stringify(before.map(entry => entry.captureStage))}`)
          }
        }
        // 新入口存在且可重复调用：入队为空的第二次 flush 是 no-op，集合不得变化（无重复写入）。
        const beforeIds = idsOf(before)
        await harnessSlots.peek(sessionId)!.flushAudit()
        await harnessSlots.peek(sessionId)!.flushAudit()
        const afterFlush = await snapshotEntries(sessionId)
        if (idsOf(afterFlush) !== beforeIds) {
          throw new Error(`flush 改变了快照集合：${beforeIds} → ${idsOf(afterFlush)}`)
        }
        // 释放槽：close() 前的 flush 兜住迟到快照（轮内补 flush 之后不应再有新增，集合仍不变）。
        await harnessSlots.dispose(sessionId)
        const afterDispose = await snapshotEntries(sessionId)
        if (idsOf(afterDispose) !== beforeIds) {
          throw new Error(`释放槽改变了快照集合：${beforeIds} → ${idsOf(afterDispose)}`)
        }
      } },
    ],
  }],
}

export default 审计闭环
