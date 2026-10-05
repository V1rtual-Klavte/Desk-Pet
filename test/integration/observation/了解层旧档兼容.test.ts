import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { setTestDataRoot } from "../../host/node-ipc"
import { initPaths, runtimePath } from "@/services/paths"
import { getHostBridge } from "@/services/host"
import { getRecentTargetReadAttempts, getUnderstandingSnapshot, loadObservationStore } from "@/services/observation/store"

let root = ""

beforeAll(async () => {
  const testTempRoot = join(process.cwd(), "test", ".tmp")
  mkdirSync(testTempRoot, { recursive: true })
  root = mkdtempSync(join(testTempRoot, "observation-legacy-"))
  setTestDataRoot(root)
  await initPaths()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("了解层旧档与非法字段读取", () => {
  it("加载时保留 dir 记录与有界 targets，非法目标/类型/记账不炸读取 [observation-legacy-store-compat]", async () => {
    const now = Date.now()
    const longPath = "/" + "x".repeat(499)
    const path = await runtimePath("data", "behavior", "understanding.json")
    await getHostBridge().request("file_write", {
      path,
      maxBytes: 256 * 1024,
      content: JSON.stringify({
        schemaVersion: 1,
        observations: [
          { sourceId: "dir-1", kind: "dir", observedAt: now - 1_000, expiresAt: now + 60_000, summary: "目录摘要", targets: [longPath, "/b", 42] },
          { sourceId: "plain-1", kind: "file", observedAt: now - 1_000, expiresAt: now + 60_000, summary: "旧记录" },
          { sourceId: "bad-kind", kind: "emotion", observedAt: now - 1_000, expiresAt: now + 60_000, summary: "非法类型" },
        ],
        topics: [],
        invalidatedTopicSources: [],
        topicClearedAt: 0,
        lastAuxiliaryAttemptAt: 0,
        targetReadAttempts: [now, now - 5_000],
      }),
    })
    await loadObservationStore()

    const snapshot = getUnderstandingSnapshot(now)
    expect(snapshot.observations.map(row => row.sourceId), "非法 kind 记录没有在读取时被滤掉").toEqual(["dir-1", "plain-1"])
    const dirRow = snapshot.observations.find(row => row.sourceId === "dir-1")
    expect(dirRow?.targets?.length, "审计路径数量没有按上限截断").toBe(2)
    expect(dirRow?.targets?.[0]?.length, "单条审计路径没有按上限截断").toBe(240)
    const plainRow = snapshot.observations.find(row => row.sourceId === "plain-1")
    expect(plainRow !== undefined && "targets" in plainRow, "旧记录被补出并不存在的审计字段").toBe(false)
    expect(getRecentTargetReadAttempts(now), "持久记账没有从旧档读出").toHaveLength(2)
  })
})
