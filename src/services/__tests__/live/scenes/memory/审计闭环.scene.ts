import { PROMPT_SNAPSHOT_ENTRY, harnessSlots } from "@/services/engine/pi"
import { initChat, sendActiveMessage } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session"
import { estimateContextTokens } from "@/services/context"
import { installFakeProvider, fakeText, fakeToolCall } from "../../fake-provider"
import { sessionEntries } from "../../session-entries"
import type { SceneDef } from "../../types"

// ── 场景口径：审计落盘闭环（三档快照各至少一条，且集合不因 flush / 释放槽而变） ──
//
// 审计条目只入队（hook 内写 lane 会死锁），落盘由唯一的 flush 入口在 lane 空闲时完成：
// 回合收尾、手动压缩收尾、槽关闭前，以及回合结算前对快照任务的那一次补 flush。
// 这个场景把「证据链的组成项不会在槽生命周期结束时静默消失」钉在真实 production 回合上：
// 一轮工具调用会让 transform_context / provider_payload / provider_usage 三档快照都产生。
// 同一场景再追加一轮主动搭话：瞬时输入的 token 归属（ephemeral 而不是 transcript）也在这条
// 证据链上，分配账目写错时「这批 token 属于谁」在重启后无从核对。
const SNAPSHOTS = PROMPT_SNAPSHOT_ENTRY

/** 主动搭话的正文：旧口径把它按 `role === "user"` 过滤掉了，于是 0 token 记进 ephemeral。 */
const ACTIVE_TEXT = "主动搭话的窗口内容：这条不是用户输入，属于本回合的瞬时输入。"

let provider: ReturnType<typeof installFakeProvider> | undefined

interface SnapshotRow {
  id: string
  captureStage: string
  data: Record<string, unknown>
}

/** 快照条目的 id 与 captureStage：集合断言只看 id，档位断言看 data.captureStage。 */
async function snapshotEntries(sessionId: string): Promise<SnapshotRow[]> {
  const entries = await sessionEntries(sessionId)
  return entries.flatMap(entry => entry.type === "custom" && entry.customType === SNAPSHOTS
    ? [{
      id: entry.id,
      captureStage: String((entry.data as { captureStage?: unknown } | undefined)?.captureStage ?? ""),
      data: (entry.data ?? {}) as Record<string, unknown>,
    }]
    : [])
}

const idsOf = (entries: Array<{ id: string }>) => entries.map(entry => entry.id).sort().join(",")

interface AllocationsRow { layer: string; requested: number; used: number; dropped?: number }

function allocationsOf(entry: SnapshotRow): AllocationsRow[] {
  const allocations = entry.data.allocations
  if (!Array.isArray(allocations)) throw new Error(`provider_usage 快照缺少 allocations: ${entry.id}`)
  return allocations as AllocationsRow[]
}

function layerOf(rows: AllocationsRow[], layer: string): AllocationsRow {
  const row = rows.find(candidate => candidate.layer === layer)
  if (!row) throw new Error(`分配账目缺少 ${layer} 层: ${JSON.stringify(rows.map(candidate => candidate.layer))}`)
  return row
}

export const 审计闭环: SceneDef = {
  meta: {
    caseId: "memory-snapshot-audit-closure",
    module: "memory",
    contractId: "mm-24",
    description: "三档快照在一轮 production 回合里各至少一条，flush 与释放槽都不改变条目集合；主动搭话回合的瞬时输入记进 ephemeral、账目 requested=used 且不写 dropped: 0",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["memory", "snapshot", "production-entry"],
  },
  setup: async () => {
    provider = installFakeProvider([fakeToolCall("system_info", {}, "audit-call"), fakeText("审计闭环完成"), fakeText("主动消息已处理")])
    await initChat()
  },
  turns: [{
    index: 1,
    description: "一轮带工具调用的 production 回合：三档快照落盘，flush 与释放槽都不改变集合；随后一轮主动搭话核对瞬时输入的归属",
    userText: "先调用 system_info，再回复。",
    checks: [
      { type: "expectActiveTransientAllocation", run: async () => {
        // 主动搭话走生产入口（sendActiveMessage）：场景的 isActiveMessage 字段只对 runtime 入口生效，
        // production 入口必须真的投递一条主动消息，才能让本回合的瞬时输入被算出来。
        const sessionId = getActiveSessionId()
        const before = new Set((await snapshotEntries(sessionId)).map(entry => entry.id))
        const reply = await sendActiveMessage(ACTIVE_TEXT)
        if (!reply.trim()) throw new Error("主动搭话回合没有回复")
        const added = (await snapshotEntries(sessionId)).filter(entry => !before.has(entry.id))
        const usage = added.filter(entry => entry.captureStage === "provider_usage")
        if (usage.length !== 1) {
          throw new Error(`主动搭话回合应恰好产生一条 provider_usage 快照，实际 ${usage.length}: ${JSON.stringify(added.map(entry => entry.captureStage))}`)
        }
        // 前提：主动消息真的进了这次请求的消息视图（custom 角色），否则下面的归属断言没有意义。
        const messages = (usage[0]!.data.agentMessages ?? []) as Array<{ role?: unknown }>
        if (!messages.some(message => message.role === "custom")) {
          throw new Error(`请求视图里没有主动消息（custom）：${JSON.stringify(messages.map(message => message.role))}`)
        }
        const rows = allocationsOf(usage[0]!)
        const transcript = layerOf(rows, "transcript")
        const ephemeral = layerOf(rows, "ephemeral")
        // 瞬时输入（主动消息）必须记进 ephemeral：旧实现只按 role === "user" 过滤，主动消息是
        // custom，transientTokens 恒 0 → 这批 token 被错记成会话历史。
        if (ephemeral.used < estimateContextTokens(ACTIVE_TEXT)) {
          throw new Error(`主动消息的 token 没有被记进 ephemeral: ${ephemeral.used} < ${estimateContextTokens(ACTIVE_TEXT)}`)
        }
        // 账目自洽：刷新后的 requested 就是实际用量（不是内核声明的份额），扣减也不会把 transcript 算成负数。
        if (transcript.requested !== transcript.used || ephemeral.requested !== ephemeral.used) {
          throw new Error(`分配账目的 requested 与 used 不一致: ${JSON.stringify([transcript, ephemeral])}`)
        }
        if (transcript.used < 0) throw new Error(`transcript 用量的扣减算成了负数: ${transcript.used}`)
        // 没有淘汰就不写 dropped（不写 0）：写 0 会让「没淘汰」与「淘汰了 0」两种账目无法区分。
        if (rows.some(row => row.dropped !== undefined && row.dropped <= 0)) {
          throw new Error(`没有淘汰的层不该写 dropped: 0：${JSON.stringify(rows)}`)
        }
      } },
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
