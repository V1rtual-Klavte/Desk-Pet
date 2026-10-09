// ==========================================
// 行为历史的历史装载与保留期清理（src/services/behavior/collector.ts）—— L2
// ==========================================
//
// 归属 L2 的依据：本文件只观测「装载时读什么清单、对哪些条目发 file_remove」——
// `file_list`/`file_read`/`file_remove` 全由记录型假桥承接（不碰真磁盘），
// 采集与落盘的真实时序不属于本层。
//
// 回归背景：`file_list` 的线格式是 `{name, path, kind, size, mtimeMs}`，没有
// `isDir`。旧实现按 `entry.isDir` 判断，运行期恒为 undefined，「按目录分段清理旧档」
// 的分支从未执行；日文件过滤也把目录条目当候选。本文件按 `kind` 钉住三条语义：
//   · 日文件候选 = 非目录 + 文件名匹配（目录条目既不读也不删）；
//   · 按日删除的旧日文件用非递归 file_remove；
//   · 超保留期的分段目录（kind=directory）必须真的走到分段清理分支（递归删除）。

import { beforeAll, describe, expect, it, vi } from "vitest"

import { getBehaviorSnapshot, observeBehavior } from "@/services/behavior"
import { setHostBridge } from "@/services/host"
import type { HostBridge } from "@/services/host"
import { initPaths } from "@/services/paths"
import type { WindowObservation } from "@/services/window/types"
import { UnsupportedInNodeError } from "../../host/unsupported"

const ROOT = "/deskpet-behavior-retention-test"
const DAILY_PATH = `${ROOT}/data/behavior/daily`
const SEGMENTS_PATH = `${ROOT}/data/behavior/segments`

interface RecordedCall {
  method: string
  args: Record<string, unknown>
}

const calls: RecordedCall[] = []

/** 与 Rust FileEntry 线格式同形（没有 isDir 字段——这正是回归的根因）。 */
const DAILY_ENTRIES = [
  { name: "2999-12-31.json", path: `${DAILY_PATH}/2999-12-31.json`, kind: "file", size: 2, mtimeMs: 1 },
  { name: "2000-01-01.json", path: `${DAILY_PATH}/2000-01-01.json`, kind: "file", size: 2, mtimeMs: 1 },
  // 名字像日文件，但条目是目录：日文件候选必须把它挡在外面。
  { name: "1999-12-31.json", path: `${DAILY_PATH}/1999-12-31.json`, kind: "directory", size: 0, mtimeMs: 1 },
  { name: "notes.txt", path: `${DAILY_PATH}/notes.txt`, kind: "file", size: 9, mtimeMs: 1 },
]
const SEGMENT_ENTRIES = [
  { name: "2999-12-31", path: `${SEGMENTS_PATH}/2999-12-31`, kind: "directory", size: 0, mtimeMs: 1 },
  { name: "2000-01-01", path: `${SEGMENTS_PATH}/2000-01-01`, kind: "directory", size: 0, mtimeMs: 1 },
  // 名字像分段目录，但条目是文件：分段清理只认目录。
  { name: "1999-12-30", path: `${SEGMENTS_PATH}/1999-12-30`, kind: "file", size: 5, mtimeMs: 1 },
]

const bridge = {
  async request(method: string, args: Record<string, unknown>) {
    calls.push({ method, args })
    if (method === "get_runtime_paths") {
      return {
        data: `${ROOT}/data`,
        memory: `${ROOT}/memory`,
        sessions: `${ROOT}/sessions`,
        personality: `${ROOT}/personality`,
        profiles: `${ROOT}/profiles`,
        settings: `${ROOT}/settings`,
        configFile: `${ROOT}/settings/CONFIG.yaml`,
        runtimeMode: "development",
      }
    }
    if (method === "resolve_runtime_path") {
      const { scope, segments } = args as { scope: string; segments?: string[] }
      return [ROOT, scope, ...(segments ?? [])].join("/")
    }
    if (method === "file_list") {
      const path = args.path as string
      if (path === DAILY_PATH) return { entries: DAILY_ENTRIES }
      if (path === SEGMENTS_PATH) return { entries: SEGMENT_ENTRIES }
      throw Object.assign(new Error("测试假桥：未知目录"), { code: "PATH_NOT_FOUND" })
    }
    if (method === "file_read") {
      const path = args.path as string
      const date = path.slice(path.lastIndexOf("/") + 1, -".json".length)
      // 装载校验要求 `day.date === 文件名前缀` 且 hourMs 长度为 24。
      return { content: JSON.stringify({ date, hourMs: new Array(24).fill(0) }) }
    }
    return null
  },
  subscribe() {
    throw new UnsupportedInNodeError("event.listen(window-observed)")
  },
  async readBlob() {
    throw new UnsupportedInNodeError("readBlob")
  },
  async releaseBlob() {},
} as unknown as HostBridge

function recorded(method: string): RecordedCall[] {
  return calls.filter(call => call.method === method)
}

/** 一条合法观察：只为驱动历史装载（started=false 时 ingest 在装载后早退）。 */
function observation(): WindowObservation {
  return {
    appId: "com.apple.Safari",
    app: "Safari",
    title: "文档",
    observedAt: 1_800_000_000_000,
    sampleMonoMs: 1_000,
    monitorGeneration: 1,
    sequence: 1,
    observationState: "observed",
    idleForMs: 0,
    isPetVisible: true,
    isPetForeground: true,
  }
}

beforeAll(async () => {
  setHostBridge(bridge)
  await initPaths()
  // 历史装载只发生一次（loaded 标记），清理是它的收尾步骤——驱动一次后各用例
  // 只对记录面做断言，不再重复调用。
  await observeBehavior(observation())
})

describe("行为历史保留期清理（file_list 条目按 kind 判定）", () => {
  it("超保留期的日文件与旧分段目录各走各的清理分支：递归标志与类型语义都不串", () => {
    const removals = recorded("file_remove").map(call => call.args)
    // 两份旧计量 daily 先隔离删除，再删除一份过期 segment 目录；旧 daily 即使
    // 日期看似未来也不能继续进入新版画像或留作新版来源资格。
    expect(
      removals,
      "旧 daily 与旧 segment 都应被清理，且目录分支必须按 kind 识别",
    ).toHaveLength(3)
    expect(removals, "旧日文件按日删除，非递归").toContainEqual({
      path: `${DAILY_PATH}/2999-12-31.json`,
      recursive: false,
      force: true,
    })
    expect(removals, "旧日文件按日删除，非递归").toContainEqual({
      path: `${DAILY_PATH}/2000-01-01.json`,
      recursive: false,
      force: true,
    })
    expect(removals, "旧分段目录按目录整体删除，递归").toContainEqual({
      path: `${SEGMENTS_PATH}/2000-01-01`,
      recursive: true,
      force: true,
    })
  })

  it("保留期内或类型与分支不符的条目一律不动：日文件候选排除目录，分段清理只认目录", () => {
    // 先读一次计量版本 marker，再读取两个真正符合「非目录 + 日文件名」的候选。目录条目
    // （1999-12-31.json）若混进候选会在这里多出一次 file_read。
    expect(recorded("file_read").map(call => call.args.path)).toEqual([
      `${ROOT}/data/behavior/measurement-state.json`,
      `${DAILY_PATH}/2999-12-31.json`,
      `${DAILY_PATH}/2000-01-01.json`,
    ])
    // 保留期内的 segment 目录、类型不符的条目（目录形日文件、文件形分段目录、
    // 非日文件）都不得出现在删除清单里；旧 daily 已由独立版本隔离规则删除。
    const removedPaths = recorded("file_remove").map(call => call.args.path)
    expect(removedPaths).not.toContain(`${SEGMENTS_PATH}/2999-12-31`)
    expect(removedPaths).not.toContain(`${SEGMENTS_PATH}/1999-12-30`)
    expect(removedPaths).not.toContain(`${DAILY_PATH}/1999-12-31.json`)
    expect(removedPaths).not.toContain(`${DAILY_PATH}/notes.txt`)
  })

  it("旧计量格式不回填新画像 [behavior-legacy-measurement-quarantine]", () => {
    expect(getBehaviorSnapshot().quality).toMatchObject({ status: "unavailable", sampleDays: 0, eligibleCollectionMs: 0 })
  })

  it("历史读取失败可重试，旧计量闭包确认后重启不重复撤销 [behavior-history-retry-and-marker-ack]", async () => {
    vi.resetModules()

    const root = "/deskpet-behavior-history-retry-test"
    const dailyPath = `${root}/data/behavior/daily`
    const markerPath = `${root}/data/behavior/measurement-state.json`
    const calls: RecordedCall[] = []
    const files = new Map<string, string>()
    files.set(markerPath, JSON.stringify({ measurementVersion: 2, derivedBehaviorInvalidationPending: false }))
    const dailyEntries = [
      { name: "2999-12-31.json", path: `${dailyPath}/2999-12-31.json`, kind: "file", size: 2, mtimeMs: 1 },
    ]
    let failDailyListing = true
    const retryBridge = {
      async request(method: string, args: Record<string, unknown>) {
        calls.push({ method, args })
        if (method === "get_runtime_paths") return {
          data: `${root}/data`, memory: `${root}/memory`, sessions: `${root}/sessions`,
          personality: `${root}/personality`, profiles: `${root}/profiles`, settings: `${root}/settings`,
          configFile: `${root}/settings/CONFIG.yaml`, runtimeMode: "development",
        }
        if (method === "resolve_runtime_path") {
          const { scope, segments } = args as { scope: string; segments?: string[] }
          return [root, scope, ...(segments ?? [])].join("/")
        }
        if (method === "file_read") {
          const path = args.path as string
          const content = files.get(path)
          if (content !== undefined) return { content }
          if (path === `${dailyPath}/2999-12-31.json`)
            return { content: JSON.stringify({ date: "2999-12-31", hourMs: Array(24).fill(0) }) }
          throw Object.assign(new Error(`missing file: ${path}`), { code: "PATH_NOT_FOUND" })
        }
        if (method === "file_write_atomic") {
          files.set(args.path as string, args.content as string)
          return null
        }
        if (method === "file_list") {
          const path = args.path as string
          if (path === dailyPath) {
            if (failDailyListing) {
              failDailyListing = false
              throw Object.assign(new Error("transient history read failure"), { code: "IO_ERROR" })
            }
            return { entries: [...dailyEntries] }
          }
          throw Object.assign(new Error(`missing directory: ${path}`), { code: "PATH_NOT_FOUND" })
        }
        if (method === "file_remove") {
          const path = args.path as string
          const index = dailyEntries.findIndex(entry => entry.path === path)
          if (index >= 0) dailyEntries.splice(index, 1)
          files.delete(path)
          return true
        }
        return null
      },
      subscribe() { throw new UnsupportedInNodeError("event.listen(window-observed)") },
      async readBlob() { throw new UnsupportedInNodeError("readBlob") },
      async releaseBlob() {},
    } as unknown as HostBridge

    const loadBehavior = async () => {
      const host = await import("@/services/host")
      const paths = await import("@/services/paths")
      host.setHostBridge(retryBridge)
      await paths.initPaths()
      return import("@/services/behavior")
    }

    const firstProcess = await loadBehavior()
    await expect(firstProcess.needsBehaviorDerivedInvalidation()).rejects.toThrow("transient history read failure")
    expect(calls.some(call => call.method === "file_remove" && call.args.path === dailyEntries[0]?.path)).toBe(false)

    expect(await firstProcess.needsBehaviorDerivedInvalidation()).toBe(true)
    expect(dailyEntries).toHaveLength(0)
    const markerWritesBeforeAck = calls.filter(call => call.method === "file_write_atomic" && call.args.path === markerPath)
    expect(markerWritesBeforeAck).toHaveLength(1)
    expect(JSON.parse(markerWritesBeforeAck[0]!.args.content as string)).toMatchObject({
      measurementVersion: 2, derivedBehaviorInvalidationPending: true,
    })
    expect(calls.findIndex(call => call.method === "file_write_atomic" && call.args.path === markerPath))
      .toBeLessThan(calls.findIndex(call => call.method === "file_remove" && call.args.path === `${dailyPath}/2999-12-31.json`))

    await firstProcess.completeBehaviorDerivedInvalidation()
    expect(JSON.parse(files.get(markerPath)!)).toMatchObject({
      measurementVersion: 2, derivedBehaviorInvalidationPending: false,
    })

    vi.resetModules()
    const secondProcess = await loadBehavior()
    expect(await secondProcess.needsBehaviorDerivedInvalidation()).toBe(false)
    expect(calls.filter(call => call.method === "file_write_atomic" && call.args.path === markerPath)).toHaveLength(2)
  })
})
