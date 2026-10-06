// ==========================================
// 派生行为结论的来源登记（系统观察 → 长期记忆的准入面，2026-10-06 方案 b）
// ==========================================
//
// 画像层算出的稳定结论经 `collectBehaviorMemorySources` 登记为 `derived_behavior` 来源：
//  · 非 reliable 档不登记任何来源（原始观察进不了记忆）；
//  · 来源身份含结论文本 hash：同结论幂等、新结论即新版本；
//  · 语义是「系统观察得出的、可撤销的结论」：taint=derived、不可冒充 trusted_user。
//
// 边界替换：画像快照（真聚合会读采集器内存）用替身冻结；来源登记（Rust IPC）用替身捕获；
// 其余走真实实现（sedimentConclusions、hash、来源形状都是被测对象）。
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { buildSnapshot, emptyDaily } from "@/services/behavior/aggregate"
import type { BehaviorDaily, BehaviorSnapshot } from "@/services/behavior/types"

const behavior = vi.hoisted(() => ({ snapshot: null as unknown as BehaviorSnapshot }))
vi.mock("@/services/behavior", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/behavior")>()
  return { ...actual, getBehaviorSnapshot: () => behavior.snapshot }
})

const ipc = vi.hoisted(() => ({ registerMemorySources: vi.fn(async (_sources: unknown[]) => 0) }))
vi.mock("@/services/agent/memory/ipc", () => ipc)

import { collectBehaviorMemorySources } from "@/services/agent/memory/sources"

const HOUR = 60 * 60_000
let root = ""

beforeAll(async () => {
  // 测试数据根：模块链接期个性加载器会取一次宿主路径，缺根会刷错误日志（与本用例无关）。
  root = mkdtempSync(join(tmpdir(), "deskpet-derived-source-"))
  const { setTestDataRoot } = await import("../../host/node-ipc")
  setTestDataRoot(root)
  const paths = await import("@/services/paths")
  await paths.initPaths()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function snapshotOf(days: BehaviorDaily[]): BehaviorSnapshot {
  return buildSnapshot(days, Date.parse("2026-10-04T12:00:00"), 0, null)
}

function reliableSnapshot(): BehaviorSnapshot {
  const days = ["2026-10-01", "2026-10-02", "2026-10-03"].map(date => {
    const day = emptyDaily(date)
    day.coveredMs = 6 * HOUR
    day.unobservedMs = 4 * HOUR
    day.activeMs = 5 * HOUR
    day.idleMs = 1 * HOUR
    day.categoryMs.development += 3 * HOUR
    day.hourMs[20] += HOUR
    return day
  })
  return snapshotOf(days)
}

describe("派生结论来源登记", () => {
  it("reliable 档登记系统观察来源，身份与内容 hash 成对 [derived-behavior-source-registration]", async () => {
    ipc.registerMemorySources.mockClear()
    behavior.snapshot = reliableSnapshot()
    const sources = await collectBehaviorMemorySources(1_700_000_000_000)
    expect(sources.length).toBeGreaterThanOrEqual(1)
    expect(ipc.registerMemorySources, "登记没有走唯一来源登记入口").toHaveBeenCalledTimes(1)
    const registered = ipc.registerMemorySources.mock.calls[0]![0] as Array<Record<string, unknown>>
    expect(registered).toEqual(sources)
    for (const source of sources) {
      expect(source.origin, "派生了非系统观察来源").toBe("derived_behavior")
      expect(source.taint, "系统观察冒充了用户事实的 taint").toBe("derived")
      expect(source.eligibleForMemory).toBe(true)
      expect(source.sessionId).toBe("behavior")
      expect(String(source.entryId)).toMatch(/^conclusion:(rhythm|apps|focus|activity)$/)
      expect(String(source.evidence)).toContain("判据")
      // 来源身份 = 槽位 + 结论文本 hash 前缀：文本变则身份变（新版本）。
      const expectedHash = createHash("sha256").update(String(source.evidence)).digest("hex")
      expect(source.contentHash).toBe(expectedHash)
      expect(String(source.sourceId)).toBe(`behavior-conclusion:${String(source.entryId).slice("conclusion:".length)}:${expectedHash.slice(0, 16)}`)
      expect(source.seq).toBe(1_700_000_000_000)
    }
    // 同输入重登记：身份稳定（幂等），不因重跑产生新来源版本。
    const again = await collectBehaviorMemorySources(1_700_000_000_000)
    expect(again.map(source => source.sourceId)).toEqual(sources.map(source => source.sourceId))
  })

  it("非 reliable 档不登记任何来源 [derived-behavior-gate-blocks-registration]", async () => {
    ipc.registerMemorySources.mockClear()
    // 两个观察日 = insufficient；没有有效采集时间 = unavailable。
    const insufficient = snapshotOf([
      { ...emptyDaily("2026-10-02"), coveredMs: 6 * HOUR, unobservedMs: 4 * HOUR },
      { ...emptyDaily("2026-10-03"), coveredMs: 6 * HOUR, unobservedMs: 4 * HOUR },
    ])
    behavior.snapshot = insufficient
    expect(await collectBehaviorMemorySources(1_700_000_000_000)).toEqual([])
    behavior.snapshot = snapshotOf([])
    expect(await collectBehaviorMemorySources(1_700_000_000_000)).toEqual([])
    expect(ipc.registerMemorySources, "非 reliable 档登记了来源").not.toHaveBeenCalled()
  })

  it("结论变化产生新来源版本，身份与旧版本不同 [derived-behavior-new-source-version]", async () => {
    behavior.snapshot = reliableSnapshot()
    const before = await collectBehaviorMemorySources(1_700_000_000_000)
    const moved = ["2026-10-01", "2026-10-02", "2026-10-03"].map(date => {
      const day = emptyDaily(date)
      day.coveredMs = 6 * HOUR
      day.unobservedMs = 4 * HOUR
      day.hourMs[9] += HOUR
      return day
    })
    behavior.snapshot = snapshotOf(moved)
    const after = await collectBehaviorMemorySources(1_700_000_001_000)
    const rhythmBefore = before.find(source => source.entryId === "conclusion:rhythm")!
    const rhythmAfter = after.find(source => source.entryId === "conclusion:rhythm")!
    expect(rhythmAfter.evidence, "作息输入变了但结论文本没变（用例前提失效）").not.toBe(rhythmBefore.evidence)
    expect(rhythmAfter.sourceId, "新结论与旧版本共用身份（覆盖语义被破坏）").not.toBe(rhythmBefore.sourceId)
    expect(rhythmAfter.seq, "新版本没有推进水位序号").toBeGreaterThan(rhythmBefore.seq)
  })
})
