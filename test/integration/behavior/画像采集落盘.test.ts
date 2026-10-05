import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { setTestDataRoot } from "../../host/node-ipc"
import { getHostBridge } from "@/services/host"
import { clearBehavior, getBehaviorSnapshot, observeBehavior, startBehavior, stopBehavior } from "@/services/behavior"
import { initPaths, runtimePath } from "@/services/paths"
import type { WindowObservation } from "@/services/window"

let root = ""

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-behavior-"))
  setTestDataRoot(root)
  await initPaths()
})

afterAll(async () => {
  await clearBehavior()
  rmSync(root, { recursive: true, force: true })
})

function observation(sequence: number, monitorGeneration = 8): WindowObservation {
  return {
    appId: "com.visualstudio.code", app: "Editor", title: "private title must not persist",
    observedAt: 1_800_000_000_000 + sequence * 3_000, sampleMonoMs: sequence * 3_000,
    monitorGeneration, sequence, observationState: "observed", idleForMs: 0,
    isPetVisible: true, isPetForeground: false,
  }
}

describe("behavior 聚合与落盘", () => {
  it("以心跳合并连续开发段，日聚合与片段都不保存窗口标题 [behavior-persisted-rollup]", async () => {
    await clearBehavior()
    startBehavior()
    for (let sequence = 1; sequence <= 21; sequence++) {
      const sample = observation(sequence)
      await observeBehavior(sequence >= 11 ? { ...sample, appId: "org.wezfurlong.wezterm", app: "WezTerm" } : sample)
    }
    await stopBehavior()
    await observeBehavior({ ...observation(22), observationState: "disabled", appId: null, app: null, title: null })

    const at = new Date(observation(1).observedAt)
    const date = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`
    const dailyPath = await runtimePath("data", "behavior", "daily", `${date}.json`)
    const { content } = await getHostBridge().request("file_read", { path: dailyPath, maxBytes: 2 * 1024 * 1024 })
    const daily = JSON.parse(content) as { categoryMs: Record<string, number>; workTotalMs: number; workSegments: number; workLongestMs: number; appMs: Record<string, number> }
    const snapshot = getBehaviorSnapshot()
    const segmentPath = await runtimePath("data", "behavior", "segments", date, "0001.jsonl")
    const { content: segment } = await getHostBridge().request("file_read", { path: segmentPath, maxBytes: 512 * 1024 })

    expect(daily.categoryMs.development).toBe(60_000)
    expect(daily.workTotalMs).toBe(60_000)
    expect(daily.workSegments).toBe(1)
    expect(daily.workLongestMs).toBe(60_000)
    expect(daily.appMs["com.visualstudio.code"]).toBe(30_000)
    expect(daily.appMs["org.wezfurlong.wezterm"]).toBe(30_000)
    expect(snapshot.focus.currentContinuousMs).toBe(0)
    expect(segment).not.toContain("private title must not persist")
    expect(segment).toContain('"category":"development"')
  })

  it("关闭 collector 后清除文件和内存画像，迟到事件不能回写 [behavior-clear-erases-source]", async () => {
    await clearBehavior()
    startBehavior()
    await observeBehavior(observation(1, 9))
    await observeBehavior(observation(2, 9))
    await clearBehavior()
    const path = await runtimePath("data", "behavior")
    const bridge = getHostBridge()
    const cleared = await bridge.request("file_list", { path })
    expect(cleared.entries.map(entry => entry.name)).toEqual(["understanding.json"])
    const markerPath = await runtimePath("data", "behavior", "understanding.json")
    const marker = JSON.parse((await bridge.request("file_read", { path: markerPath })).content)
    expect(marker.observations).toEqual([])
    expect(marker.topics).toEqual([])
    expect(getBehaviorSnapshot().quality.sampleDays).toBe(0)
    await observeBehavior(observation(2, 9))
    const afterLate = await bridge.request("file_list", { path })
    expect(afterLate.entries.map(entry => entry.name)).toEqual(["understanding.json"])
    await observeBehavior(observation(3, 9))
    await observeBehavior(observation(4, 9))
    await stopBehavior()
    await observeBehavior({ ...observation(5, 9), observationState: "disabled", appId: null, app: null, title: null })
    expect(await bridge.request("file_exists", { path })).toBe(true)
  })
})
