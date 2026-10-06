// ==========================================
// 压缩续跑异常结算 —— 手动压缩的续跑「已结算 / 不支持的 suspended」两条异常归宿
//
// 被测：`HarnessSlot.compact`（harness-slot.ts 的续跑收口段）。压缩提交成功后，Harness 会
// 再驱动一次续跑消费 lane 持久 inbox；那段续跑**没有宿主回合** —— 它若已结算（completed/
// failed/aborted/declined 任一终态），压缩结果就不可能进入任何回合结算与 UI，不能报
// 「压缩完成」；它若挂起（suspended，不结算的操作），后续准入会恒判忙，必须显式取消结算。
// 两条分支共同的口径：返回 failed（不谎报 completed），已结算的那条还要落
// `deskpet.compaction_continuation` 审计条目（operationId + 终态），供追溯。
//
// 归 L3 的理由：直连运行槽与真实 lane（`@/services/engine/harness` 命中 L2 禁入清单），
// 压缩路径的会话写入（审计条目 flush）要真 JSONL 落盘。为了确定性地走到这两条异常分支，
// 用 `vi.spyOn(lane, "compact")` 替换**压缩调用的返回值**（lane 本身与槽都是真的）——
// 真实 lane 无法产出「已结算的续跑」（正常路径根本不会返回该形态），只能以桩驱动分支。
// 桩替换的是调用结果、不是被断言的判定逻辑：终态映射、审计落盘与 abort 调用都在产品代码里。
//
// 与 `压缩挂起结算.test.ts` 的分工：那一条测「Provider 返回延迟响应」的回合结算（abort 挂起
// 操作）；本文件测**压缩续跑**的收口分支，两者都在 harness-slot 的异常面，不重叠。
//
// 未运行声明：按实施期纪律，本文件只写不跑，断言对错留验收环节（首跑见红时先对质问
// 「断言写错 vs 实现缺陷」，不要直接改实现迎合断言）。
// ==========================================

import type { DeferredHandle } from "@earendil-works/pi-ai"
import type { AgentLane, CompactionResult, Entry, OperationResultRecord } from "@earendil-works/pi-agent-core"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { sessionEntries } from "../../host/session-entries"
import { standardSetup } from "../../host/standard-setup"
import { createHarnessRunState, harnessSlots } from "@/services/engine/harness"
// 审计条目的 customType 常量没进 harness barrel（只有压缩拒绝/提示词重写/快照三条进了）：
// 按需直连唯一实现，不手抄字符串（抄一份就多一个会漂移的定义点）。
import { COMPACTION_CONTINUATION_ENTRY } from "@/services/engine/harness/harness-slot"
import { initChat } from "@/services/agent/runner"
import { initPaths } from "@/services/paths"
import { getActiveSessionId } from "@/services/session/store"

/** 压缩操作记录的桩：status=completed 只表示「压缩提交成功」，续跑形态由各用例分别给。 */
const COMPACTION_RECORD: OperationResultRecord = {
  operationId: "op-compact-probe",
  kind: "compaction",
  status: "completed",
  fromTipId: null,
  tipId: null,
  startedAt: 1,
  endedAt: 2,
}

/** 已结算的续跑记录（正常路径不会以这个形态返回 —— 续跑本就没有宿主回合去结算它）。 */
const SETTLED_CONTINUATION_RECORD: OperationResultRecord = {
  operationId: "op-compaction-continuation-settled",
  kind: "run",
  status: "completed",
  fromTipId: null,
  tipId: null,
  startedAt: 2,
  endedAt: 3,
}

/** 挂起的续跑记录：句柄字段在收口判定里不被读，取与生效模型无关的合法形状。 */
const SUSPENDED_CONTINUATION_HANDLE: DeferredHandle = {
  provider: "deskpet-fake",
  modelId: "deskpet-fake",
  api: "openai-completions",
  id: "deferred-compaction-continuation",
  pollAfterMs: 50,
}

let dataRoot = ""

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), "deskpet-compaction-continuation-"))
  setTestDataRoot(dataRoot)
  await initPaths()
})

afterAll(() => {
  rmSync(dataRoot, { recursive: true, force: true })
})

beforeEach(async () => {
  await standardSetup()
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** 打开一个真实槽并取到它的真实 lane（与 压缩挂起结算.test.ts 同款，不另建替身）。 */
async function openSlotWithLane() {
  await initChat()
  const sessionId = getActiveSessionId()
  expect(sessionId, "没有活跃会话，压缩入口无从驱动").not.toBe("")
  const slot = harnessSlots.ensure(sessionId)
  await slot.open()
  const lane = (slot as unknown as { lane: AgentLane }).lane
  expect(lane, "槽打开后没有 lane，压缩入口无从驱动").toBeDefined()
  return { sessionId, slot, lane }
}

/** 本会话的 `deskpet.compaction_continuation` 审计条目（原始条目，不经读模型）。 */
async function continuationAuditEntries(sessionId: string): Promise<Extract<Entry, { type: "custom" }>[]> {
  const entries = await sessionEntries(sessionId)
  return entries.filter((entry): entry is Extract<Entry, { type: "custom" }> =>
    entry.type === "custom" && entry.customType === COMPACTION_CONTINUATION_ENTRY)
}

describe("压缩续跑异常结算（无宿主回合的续跑收口）", () => {
  it("续跑以已结算形态返回：压缩不得报完成，落 deskpet.compaction_continuation 审计条目（operationId + 终态）[runtime-compaction-continuation-settled]", async () => {
    const { sessionId, slot, lane } = await openSlotWithLane()
    // 只桩「压缩调用的返回值」：入参校验、终态映射、审计 flush 全部走产品代码。
    vi.spyOn(lane, "compact").mockResolvedValue({
      ok: true,
      value: { compaction: COMPACTION_RECORD, run: SETTLED_CONTINUATION_RECORD },
    } satisfies CompactionResult)

    const outcome = await slot.compact({ systemPrompt: "压缩续跑结算测试提示词", state: createHarnessRunState() })

    // ① 终态：不得谎报「压缩完成」—— 续跑的消费没有进入任何回合结算与 UI。
    expect(outcome.status, `已结算的续跑不得报压缩完成: ${JSON.stringify(outcome)}`).toBe("failed")
    expect(outcome.error, "失败原因应说明续跑已结算、压缩结果未纳入回合结算").toContain("未纳入回合结算")

    // ② 审计落盘：条目带会话、续跑 operationId 与终态（压缩提交本身的行为不写在这里）。
    const audits = await continuationAuditEntries(sessionId)
    expect(audits.length, `续跑结算应收口恰好一条审计条目，实际 ${audits.length} 条`).toBe(1)
    expect(audits[0]?.data, "审计条目应带 sessionId / operationId / status").toMatchObject({
      sessionId,
      operationId: SETTLED_CONTINUATION_RECORD.operationId,
      status: SETTLED_CONTINUATION_RECORD.status,
    })
  }, 60_000)

  it("续跑以不支持的 suspended 形态返回：显式结算该操作（abort）并如实失败，不落续跑审计条目 [runtime-compaction-continuation-suspended]", async () => {
    const { sessionId, slot, lane } = await openSlotWithLane()
    vi.spyOn(lane, "compact").mockResolvedValue({
      ok: true,
      value: {
        compaction: COMPACTION_RECORD,
        run: { operationId: "op-compaction-continuation-suspended", status: "suspended", deferred: SUSPENDED_CONTINUATION_HANDLE },
      },
    } satisfies CompactionResult)

    const abortSpy = vi.spyOn(lane, "abort")
    const outcome = await slot.compact({ systemPrompt: "压缩续跑结算测试提示词", state: createHarnessRunState() })

    // ① 挂起的续跑必须被显式结算掉（只返回 failed 会让槽背着永不结算的操作、后续准入恒判忙）。
    expect(abortSpy, "挂起的续跑没有被取消结算（lane.abort 未调用）").toHaveBeenCalledTimes(1)
    // ② 终态：如实失败，不声称压缩完成。
    expect(outcome.status, `挂起的续跑不得报压缩完成: ${JSON.stringify(outcome)}`).toBe("failed")
    expect(outcome.error, "失败原因应说明续跑返回了不支持的延迟响应").toContain("不支持的延迟响应")
    // ③ 该分支不落续跑审计条目（没有「已结算」的事实可记）。
    expect(await continuationAuditEntries(sessionId), "suspended 分支不应落 compaction_continuation 审计条目").toHaveLength(0)
    // ④ 收口后会话不再被判忙：下一次准入不被挂起操作挡住。
    expect(await harnessSlots.hasOpenOperation(sessionId), "续跑被结算后会话仍判忙").toBe(false)
  }, 60_000)
})
