// ==========================================
// 静默了解观察的来源登记（了解摘要 → 长期记忆的准入面，2026-10-06 用户裁决）
// ==========================================
//
// 口径：
//  · 了解摘要经 `collectUnderstandingMemorySources` 登记为 `derived_behavior` 来源
//    （与画像结论同 origin、同合成会话 `behavior`，但条目身份前缀 `understanding:` 区分）；
//  · 身份 = artifact id、输入 hash 和摘要文本的组合 hash 前 16 位；contentHash 单独校验摘要文本；
//  · **有界窗口**：每次只登记最新的 `UNDERSTANDING_MAX_ENTRIES`（12）条不同 artifact 观察
//    —— 依据是了解层自己的读取窗口（了解块取最近 12 条、决策取最近 8 条）；
//  · 档位 off（读取返回 unavailable）时返回空数组、不登记任何来源。
//
// 边界替换：了解层快照、证据对账与来源登记 IPC 用替身；其余走真实实现（hash、身份拼装、窗口裁剪）。
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

interface ObservationRecordFixture {
  sourceId: string
  evidenceId?: string
  evidenceHash?: string
  kind: string
  observedAt: number
  expiresAt: number
  summary: string
}

interface UnderstandingSnapshotFixture {
  revision: number
  generatedAt: number
  quality: string
  coverage: number
  independentSources: number
  observations: ObservationRecordFixture[]
}

const observation = vi.hoisted(() => ({
  snapshot: null as null | UnderstandingSnapshotFixture,
}))
vi.mock("@/services/observation", () => ({
  getUnderstandingSnapshotAsync: async () =>
    observation.snapshot ?? { revision: 0, generatedAt: Date.now(), quality: "unavailable", coverage: 0, independentSources: 0, observations: [] },
}))

const ipc = vi.hoisted(() => ({ registerMemorySources: vi.fn(async (_sources: unknown[]) => 0) }))
vi.mock("@/services/agent/memory/ipc", () => ipc)
const evidence = vi.hoisted(() => ({ reconcileDerivedMemoryEvidence: vi.fn(async () => undefined) }))
vi.mock("@/services/agent/memory/evidence", () => evidence)

import { collectUnderstandingMemorySources, UNDERSTANDING_MAX_ENTRIES } from "@/services/agent/memory/sources"

let root = ""

beforeAll(async () => {
  // 测试数据根：模块链接期个性加载器会取一次宿主路径，缺根会刷错误日志（与本用例无关）。
  root = mkdtempSync(join(tmpdir(), "deskpet-understanding-source-"))
  const { setTestDataRoot } = await import("../../host/node-ipc")
  setTestDataRoot(root)
  const paths = await import("@/services/paths")
  await paths.initPaths()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function record(
  summary: string,
  observedAt: number,
  kind = "screenshot",
  evidenceId = `artifact:${kind}:${observedAt}`,
  evidenceHash = expectedHash(`${kind}:${observedAt}`),
): ObservationRecordFixture {
  return { sourceId: `src-${observedAt}-${kind}`, evidenceId, evidenceHash, kind, observedAt, expiresAt: observedAt + 60 * 60_000, summary }
}

function expectedHash(summary: string): string {
  return createHash("sha256").update(summary).digest("hex")
}

describe("静默了解观察的来源登记", () => {
  it("档位关闭（读取返回 unavailable）时不登记任何来源", async () => {
    ipc.registerMemorySources.mockClear()
    observation.snapshot = { revision: 1, generatedAt: 1_700_000_000_000, quality: "unavailable", coverage: 0, independentSources: 0, observations: [] }
    expect(await collectUnderstandingMemorySources(1_700_000_000_000)).toEqual([])
    observation.snapshot = null
    expect(await collectUnderstandingMemorySources(1_700_000_000_000)).toEqual([])
    expect(ipc.registerMemorySources, "关闭档位登记了了解来源").not.toHaveBeenCalled()
  })

  it("逐字登记摘要：身份含文本 hash、证据原样、seq 逐条递增", async () => {
    ipc.registerMemorySources.mockClear()
    const now = 1_700_000_000_000
    const first = "项目里在做一个 Rust 与 TypeScript 的桌宠"
    const second = "常用 VS Code 与终端"
    observation.snapshot = {
      revision: 2, generatedAt: now, quality: "ready", coverage: 2, independentSources: 2,
      observations: [record(first, now - 2_000, "file"), record(second, now - 1_000, "dir")],
    }

    const sources = await collectUnderstandingMemorySources(now)
    expect(sources).toHaveLength(2)
    expect(ipc.registerMemorySources, "登记没有走唯一来源登记入口").toHaveBeenCalledTimes(1)
    const registered = ipc.registerMemorySources.mock.calls[0]![0] as unknown[]
    expect(registered).toEqual(sources)
    for (const [index, source] of sources.entries()) {
      const summary = index === 0 ? first : second
      const observedAt = index === 0 ? now - 2_000 : now - 1_000
      const kind = index === 0 ? "file" : "dir"
      const evidenceId = `artifact:${kind}:${observedAt}`
      const evidenceHash = expectedHash(`${kind}:${observedAt}`)
      const hash = expectedHash(JSON.stringify([evidenceId, evidenceHash, summary]))
      expect(source.origin, "了解沉淀冒充了用户来源").toBe("derived_behavior")
      expect(source.taint, "了解沉淀的 taint 错配").toBe("derived")
      expect(source.eligibleForMemory).toBe(true)
      expect(source.sessionId).toBe("behavior")
      // 身份绑定 artifact、输入版本与摘要；contentHash 仍只校验摘要正文。
      expect(source.sourceId).toBe(`behavior-understanding:${hash.slice(0, 16)}`)
      expect(source.entryId).toBe(`understanding:${hash.slice(0, 16)}`)
      expect(source.eventId).toBe(`behavior:understanding:${hash.slice(0, 16)}`)
      expect(source.contentHash).toBe(expectedHash(summary))
      // 逐字沉淀：evidence 就是观察摘要原文（沉淀候选将原样采用，Review 不再演绎）。
      expect(source.evidence).toBe(summary)
      expect(source.sourceLength).toBe(summary.length)
      expect(source.observedAt).toBe(index === 0 ? now - 2_000 : now - 1_000)
      // seq 逐条递增：同批来源不会在水位上互相吞并（旧到新登记）。
      expect(source.seq).toBe(now + index)
    }

    // 同输入重登记：身份稳定（幂等），不因重跑产生新来源版本。
    const again = await collectUnderstandingMemorySources(now)
    expect(again.map(source => source.sourceId)).toEqual(sources.map(source => source.sourceId))
  })

  it("同文本重复观察只登记一条（内容去重，保留最新一次观察）", async () => {
    ipc.registerMemorySources.mockClear()
    const now = 1_700_000_000_000
    const text = "在整理一个关于模块边界的设计文档"
    const evidenceId = "artifact:repeated"
    observation.snapshot = {
      revision: 3, generatedAt: now, quality: "ready", coverage: 2, independentSources: 1,
      observations: [
        record("旧摘要", now - 5_000, "file", evidenceId, "input-v1"),
        record(text, now - 1_000, "window", evidenceId, "input-v2"),
      ],
    }

    const sources = await collectUnderstandingMemorySources(now)
    expect(sources, "同一 artifact 的多条观察产出了多条来源").toHaveLength(1)
    expect(sources[0]!.evidence).toBe(text)
    expect(sources[0]!.observedAt, "去重没有保留最新一次观察").toBe(now - 1_000)
  })

  it(`只登记最新的 ${UNDERSTANDING_MAX_ENTRIES} 条不同文本观察（有界窗口）`, async () => {
    ipc.registerMemorySources.mockClear()
    const now = 1_700_000_000_000
    const summaries = Array.from({ length: UNDERSTANDING_MAX_ENTRIES + 8 }, (_value, index) => `了解摘要-${String(index).padStart(2, "0")}`)
    observation.snapshot = {
      revision: 4, generatedAt: now, quality: "ready", coverage: UNDERSTANDING_MAX_ENTRIES + 8, independentSources: UNDERSTANDING_MAX_ENTRIES + 8,
      // 索引越大越新；窗口应留下最后 UNDERSTANDING_MAX_ENTRIES 条。
      observations: summaries.map((summary, index) => record(summary, now - 100_000 + index * 1_000, "file")),
    }

    const sources = await collectUnderstandingMemorySources(now)
    expect(sources, "窗口没有把来源数收在上限内").toHaveLength(UNDERSTANDING_MAX_ENTRIES)
    const kept = sources.map(source => source.evidence)
    expect(kept).toEqual(summaries.slice(summaries.length - UNDERSTANDING_MAX_ENTRIES))
    // 遗留的旧观察不产生来源：身份集合与窗口一致（重新登记后仍然只有这一批）。
    const again = await collectUnderstandingMemorySources(now)
    expect(again.map(source => source.evidence)).toEqual(kept)
  })

  it("缺 artifact 或输入 hash 的摘要不进入派生记忆 [understanding-source-requires-evidence]", async () => {
    ipc.registerMemorySources.mockClear()
    const now = 1_700_000_000_000
    observation.snapshot = {
      revision: 5, generatedAt: now, quality: "ready", coverage: 3, independentSources: 3,
      observations: [
        record("缺 artifact 身份", now - 3_000, "file", "", expectedHash("input-a")),
        record("缺输入版本", now - 2_000, "dir", "artifact:dir:1", ""),
        { sourceId: "legacy", kind: "screenshot", observedAt: now - 1_000, expiresAt: now + 60_000, summary: "旧版摘要" },
      ],
    }

    expect(await collectUnderstandingMemorySources(now)).toEqual([])
    expect(ipc.registerMemorySources, "无可验证证据仍调用了来源登记").not.toHaveBeenCalled()
  })
})
