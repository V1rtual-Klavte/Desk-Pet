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

import { beforeAll, describe, expect, it } from "vitest"

import { observeBehavior } from "@/services/behavior"
import { setHostBridge } from "@/services/host"
import type { HostBridge } from "@/services/host"
import { initPaths } from "@/services/paths"
import type { WindowObservation } from "@/services/window/types"

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
    throw new Error("测试假桥没有事件通道")
  },
  async readBlob() {
    throw new Error("测试假桥不提供 blob")
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
    // 恰好两条：日文件一条、旧分段目录一条。若分段分支仍按 isDir（恒 undefined）
    // 判定，这里只剩日文件一条，直接红在长度上。
    expect(
      removals,
      "旧分段目录（kind=directory）必须真的走到分段清理分支",
    ).toHaveLength(2)
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
    // 恰好两次读取：两个真正符合「非目录 + 日文件名」的候选。目录条目
    // （1999-12-31.json）若混进候选会在这里多出一次 file_read。
    expect(recorded("file_read").map(call => call.args.path)).toEqual([
      `${DAILY_PATH}/2999-12-31.json`,
      `${DAILY_PATH}/2000-01-01.json`,
    ])
    // 保留期内的分段目录、类型不符的条目（目录形日文件、文件形分段目录、
    // 非日文件）都不得出现在删除清单里（上一条已把删除总数钉为 2）。
    const removedPaths = recorded("file_remove").map(call => call.args.path)
    expect(removedPaths).not.toContain(`${SEGMENTS_PATH}/2999-12-31`)
    expect(removedPaths).not.toContain(`${SEGMENTS_PATH}/1999-12-30`)
    expect(removedPaths).not.toContain(`${DAILY_PATH}/1999-12-31.json`)
    expect(removedPaths).not.toContain(`${DAILY_PATH}/notes.txt`)
  })
})
