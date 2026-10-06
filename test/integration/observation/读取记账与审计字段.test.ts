import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { setTestDataRoot } from "../../host/node-ipc"
import { initPaths, runtimePath } from "@/services/paths"
import { getHostBridge } from "@/services/host"
import { clearSilentUnderstanding } from "@/services/observation"
import {
  appendUnderstanding, getRecentTargetReadAttempts, getUnderstandingSnapshot, recordTargetReadAttempts,
} from "@/services/observation/store"

// 清除静默了解现在会联动记忆侧的失效闭包（Rust 专属命令，Node 测试桥不持有）：
// 本文件的用例只考了解层存储的记账/审计行为，替身挂住闭包调用（语义在
// `memory_apply_change` 的 forget_understanding 与 Rust 单测覆盖）。
const memoryDomain = vi.hoisted(() => ({ forgetUnderstandingDerivedMemory: vi.fn(async () => 0) }))
vi.mock("@/services/agent/memory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/agent/memory")>()),
  forgetUnderstandingDerivedMemory: memoryDomain.forgetUnderstandingDerivedMemory,
}))

let root = ""

beforeAll(async () => {
  const testTempRoot = join(process.cwd(), "test", ".tmp")
  mkdirSync(testTempRoot, { recursive: true })
  root = mkdtempSync(join(testTempRoot, "observation-audit-"))
  setTestDataRoot(root)
  await initPaths()
})

beforeEach(async () => {
  await clearSilentUnderstanding()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

interface StoredStore {
  observations: Array<{ sourceId: string; kind: string; targets?: string[] }>
  targetReadAttempts: number[]
}

async function readStore(): Promise<StoredStore> {
  const path = await runtimePath("data", "behavior", "understanding.json")
  const { content } = await getHostBridge().request("file_read", { path, maxBytes: 256 * 1024 })
  return JSON.parse(content) as StoredStore
}

describe("静默了解读取记账", () => {
  it("读取尝试按滚动窗口记账并持久到 understanding.json [observation-read-accounting]", async () => {
    const now = Date.now()
    await recordTargetReadAttempts(2, now)
    expect(getRecentTargetReadAttempts(now), "两次读取尝试没有进入滚动记账").toHaveLength(2)
    expect((await readStore()).targetReadAttempts, "记账没有随了解层派生文件落盘").toHaveLength(2)

    await recordTargetReadAttempts(1, now - 2 * 60 * 60_000)
    expect(getRecentTargetReadAttempts(now), "窗口外历史读取占用了当前名额").toHaveLength(2)
    expect((await readStore()).targetReadAttempts, "窗口外记账没有照实保留（供页面回看）").toHaveLength(3)
  })

  it("清除了解域同时清空读取记账", async () => {
    await recordTargetReadAttempts(3, Date.now())
    expect(getRecentTargetReadAttempts().length).toBeGreaterThan(0)
    await clearSilentUnderstanding()
    expect(getRecentTargetReadAttempts(), "清除后旧读取记账仍占用每小时名额").toEqual([])
    expect((await readStore()).targetReadAttempts, "清除后派生文件仍保留读取记账").toEqual([])
  })
})

describe("静默了解审计字段", () => {
  it("了解记录随 targets 落盘，旧记录没有 targets 仍可读取 [observation-audit-targets]", async () => {
    const now = Date.now()
    await appendUnderstanding([
      { sourceId: "dir-source", kind: "dir", observedAt: now, expiresAt: now + 60_000, summary: "工作目录结构", targets: ["/Users/example/work"] },
      { sourceId: "legacy-source", kind: "file", observedAt: now, expiresAt: now + 60_000, summary: "旧记录没有审计字段" },
    ])
    const stored = await readStore()
    expect(stored.observations.find(row => row.sourceId === "dir-source")?.targets, "读取路径没有随了解记录持久").toEqual(["/Users/example/work"])
    const legacy = stored.observations.find(row => row.sourceId === "legacy-source")
    expect(legacy !== undefined && "targets" in legacy, "无 targets 的旧记录被写入空审计字段").toBe(false)

    const snapshot = getUnderstandingSnapshot(now)
    expect(snapshot.observations.find(row => row.sourceId === "dir-source")?.targets, "了解快照丢失审计字段").toEqual(["/Users/example/work"])
  })
})
