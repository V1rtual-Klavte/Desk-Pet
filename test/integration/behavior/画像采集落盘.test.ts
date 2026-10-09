import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { setTestDataRoot } from "../../host/node-ipc"
import { getHostBridge } from "@/services/host"
import { clearBehavior, getBehaviorSnapshot, observeBehavior, startBehavior, stopBehavior } from "@/services/behavior"
import { IDLE_ACTIVE_LIMIT_MS } from "@/services/behavior/types"
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
  it("短事件间隔持续观察开发应用，日聚合与分段不保存窗口标题 [behavior-persisted-rollup]", async () => {
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
    const daily = JSON.parse(content) as { measurementVersion: number; activeMs: number; idleMs: number; unknownMs: number; unobservedMs: number; categoryMs: Record<string, number>; workTotalMs: number; workSegments: number; workLongestMs: number; appMs: Record<string, number> }
    const snapshot = getBehaviorSnapshot()
    const segmentPath = await runtimePath("data", "behavior", "segments", date, "0001.jsonl")
    const { content: segment } = await getHostBridge().request("file_read", { path: segmentPath, maxBytes: 512 * 1024 })

    expect(daily.measurementVersion).toBe(2)
    expect(daily.activeMs + daily.idleMs + daily.unknownMs + daily.unobservedMs).toBe(60_000)
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

  it("长间隔由 idle 证据拆成有限活跃前缀与空闲后缀，不把离开时间计为工作 [behavior-idle-bounded-gap]", async () => {
    await clearBehavior()
    startBehavior()
    const first = observation(40, 10)
    const hour = 60 * 60_000
    await observeBehavior(first)
    await observeBehavior({ ...first, observedAt: first.observedAt + hour, sampleMonoMs: first.sampleMonoMs + hour,
      sequence: first.sequence + 1, idleForMs: hour })
    await stopBehavior()

    const date = `${new Date(first.observedAt).getFullYear()}-${String(new Date(first.observedAt).getMonth() + 1).padStart(2, "0")}-${String(new Date(first.observedAt).getDate()).padStart(2, "0")}`
    const path = await runtimePath("data", "behavior", "daily", `${date}.json`)
    const daily = JSON.parse((await getHostBridge().request("file_read", { path })).content) as {
      activeMs: number; idleMs: number; unknownMs: number; unobservedMs: number; coveredMs: number; workTotalMs: number
    }
    expect(daily).toMatchObject({ activeMs: 5 * 60_000, idleMs: 55 * 60_000, unknownMs: 0, unobservedMs: 0, coveredMs: hour, workTotalMs: 5 * 60_000 })
  })

  it("长间隔的 idle 计数回退时，证据不足部分进入 unknown 且不贡献活跃工时 [behavior-reset-idle-unknown-gap]", async () => {
    await clearBehavior()
    startBehavior()
    const first = observation(50, 11)
    const hour = 60 * 60_000
    await observeBehavior(first)
    await observeBehavior({ ...first, observedAt: first.observedAt + hour, sampleMonoMs: first.sampleMonoMs + hour,
      sequence: first.sequence + 1, idleForMs: 0 })
    await stopBehavior()

    const date = `${new Date(first.observedAt).getFullYear()}-${String(new Date(first.observedAt).getMonth() + 1).padStart(2, "0")}-${String(new Date(first.observedAt).getDate()).padStart(2, "0")}`
    const path = await runtimePath("data", "behavior", "daily", `${date}.json`)
    const daily = JSON.parse((await getHostBridge().request("file_read", { path })).content) as {
      activeMs: number; idleMs: number; unknownMs: number; unobservedMs: number; coveredMs: number; workTotalMs: number; hourMs: number[]
    }
    expect(daily).toMatchObject({ activeMs: 0, idleMs: 0, unknownMs: hour, unobservedMs: 0, coveredMs: hour, workTotalMs: 0 })
    expect(daily.hourMs.reduce((sum, value) => sum + value, 0)).toBe(0)

    // 短间隔也要考虑此前累计的 idle：若阈值可能已在间隔中越过、而末样本因输入
    // 刚重置为 0，不能把整段都补成 active。
    await clearBehavior()
    startBehavior()
    const nearThreshold = observation(60, 12)
    const shortGap = 30_000
    await observeBehavior({ ...nearThreshold, idleForMs: IDLE_ACTIVE_LIMIT_MS - 20_000 })
    await observeBehavior({ ...nearThreshold, observedAt: nearThreshold.observedAt + shortGap,
      sampleMonoMs: nearThreshold.sampleMonoMs + shortGap, sequence: nearThreshold.sequence + 1, idleForMs: 0 })
    await stopBehavior()

    const nearPath = await runtimePath("data", "behavior", "daily", `${date}.json`)
    const nearDaily = JSON.parse((await getHostBridge().request("file_read", { path: nearPath })).content) as {
      activeMs: number; idleMs: number; unknownMs: number; coveredMs: number; workTotalMs: number
    }
    expect(nearDaily).toMatchObject({ activeMs: 0, idleMs: 0, unknownMs: shortGap, coveredMs: shortGap, workTotalMs: 0 })
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
    expect(cleared.entries.map(entry => entry.name).sort()).toEqual(["measurement-state.json", "understanding.json"])
    const markerPath = await runtimePath("data", "behavior", "understanding.json")
    const marker = JSON.parse((await bridge.request("file_read", { path: markerPath })).content)
    expect(marker.observations).toEqual([])
    expect(marker.topics).toEqual([])
    expect(getBehaviorSnapshot().quality.sampleDays).toBe(0)
    await observeBehavior(observation(2, 9))
    const afterLate = await bridge.request("file_list", { path })
    expect(afterLate.entries.map(entry => entry.name).sort()).toEqual(["measurement-state.json", "understanding.json"])
    await observeBehavior(observation(3, 9))
    await observeBehavior(observation(4, 9))
    await stopBehavior()
    await observeBehavior({ ...observation(5, 9), observationState: "disabled", appId: null, app: null, title: null })
    expect(await bridge.request("file_exists", { path })).toBe(true)
  })
})
