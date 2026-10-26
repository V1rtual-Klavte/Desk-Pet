// ==========================================
// sim-eval 运行上下文 — 只信宿主写下的 ready.json
// ==========================================
//
// 评测执行器先拉起 debug 宿主（DESKPET_SIM_EVAL=1 + DESKPET_SIM_EVAL_RUN_DIR），
// 宿主拿到隔离数据根的单实例锁后写 ready.json，再由同一进程拉起本 Node。
// 因此 Node 侧不推断自己「大概在评测里」：
//   - 环境变量只是入口；真正的所有权证据是 ready.json（pid = 本进程父进程、数据根
//     与本进程 runtimePath("data") 一致、控制目录与数据根同源）。
//   - 任一校验失败都直接抛错；不降级成普通开发会话，也不回落到真实开发数据根。

import { readFile, realpath } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { getRuntimeMode, runtimePath } from "@/services/paths"
import { readSimClockFile, SIM_CLOCK_FILE } from "./clock"
import type { SimClockFile } from "./clock"

export const SIM_EVAL_ENV = "DESKPET_SIM_EVAL"
export const SIM_EVAL_RUN_DIR_ENV = "DESKPET_SIM_EVAL_RUN_DIR"
export const SIM_EVAL_READY_FILE = "ready.json"
export const SIM_EVAL_SEED_FILE = "seed.json"
export const SIM_EVAL_SEED_REPORT_FILE = "seed-report.json"
export const SIM_EVAL_READY_SCHEMA_VERSION = 1

export interface SimEvalReadyFile {
  schemaVersion: number
  generation: string
  pid: number
  runDir: string
  dataRoot: string
  controlDir: string
  runtimeMode: string
  startedAt: string
}

export interface SimEvalRunContext {
  runDir: string
  dataRoot: string
  controlDir: string
  seedPath: string
  seedReportPath: string
  clockPath: string
  clock: SimClockFile
  generation: string
  hostPid: number
  ready: SimEvalReadyFile
}

export function isSimEvalRequested(): boolean {
  return process.env[SIM_EVAL_ENV] === "1"
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`sim-eval ready.json 缺少字段 ${field}`)
  }
  return value
}

function parseReady(raw: unknown): SimEvalReadyFile {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("sim-eval ready.json 不是对象")
  }
  const record = raw as Record<string, unknown>
  if (record.schemaVersion !== SIM_EVAL_READY_SCHEMA_VERSION) {
    throw new Error(`sim-eval ready.json schemaVersion=${String(record.schemaVersion)} 不受支持`)
  }
  if (typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0) {
    throw new Error("sim-eval ready.json 的 pid 非法")
  }
  return {
    schemaVersion: record.schemaVersion,
    generation: requiredString(record.generation, "generation"),
    pid: record.pid,
    runDir: requiredString(record.runDir, "runDir"),
    dataRoot: requiredString(record.dataRoot, "dataRoot"),
    controlDir: requiredString(record.controlDir, "controlDir"),
    runtimeMode: requiredString(record.runtimeMode, "runtimeMode"),
    startedAt: requiredString(record.startedAt, "startedAt"),
  }
}

/**
 * 校验运行根形状：`<任意>/test/.tmp/sim-eval-*`。
 * 宿主侧还会按工作区根校验；这里只拒绝明显不是评测根的位置，防止 READY 路径被
 * 环境变量指向普通数据目录。
 */
function validateRunDirShape(runDir: string): void {
  if (!basename(runDir).startsWith("sim-eval-")
    || basename(dirname(runDir)) !== ".tmp"
    || basename(dirname(dirname(runDir))) !== "test") {
    throw new Error(`sim-eval 运行根形状不合法：${runDir}`)
  }
}

async function loadSimEvalRunContext(): Promise<SimEvalRunContext> {
  if (getRuntimeMode() !== "development") {
    throw new Error("sim-eval 上下文只在 development 模式可用")
  }
  const requested = process.env[SIM_EVAL_RUN_DIR_ENV]
  if (!requested) throw new Error(`sim-eval 缺少 ${SIM_EVAL_RUN_DIR_ENV}`)
  const runDir = await realpath(requested)
  validateRunDirShape(runDir)

  const ready = parseReady(JSON.parse(await readFile(join(runDir, SIM_EVAL_READY_FILE), "utf8")))
  if (resolve(ready.runDir) !== resolve(runDir)) {
    throw new Error("sim-eval ready.json 的 runDir 与本进程运行根不一致")
  }
  // 宿主是 Node 的直接父进程（监督器 Command::spawn）；pid 对不上说明 ready 来自
  // 另一个宿主实例，不能把它的数据根当成本次运行。
  if (ready.pid !== process.ppid) {
    throw new Error(`sim-eval ready.json pid=${ready.pid} 与本进程父进程 ${process.ppid} 不一致`)
  }
  if (ready.runtimeMode !== "development") {
    throw new Error(`sim-eval ready.json runtimeMode=${ready.runtimeMode}，期望 development`)
  }
  if (resolve(ready.dataRoot) !== resolve(join(runDir, "data"))) {
    throw new Error("sim-eval ready.json 的 dataRoot 不在运行根下")
  }
  if (resolve(ready.controlDir) !== resolve(join(ready.dataRoot, "logs", "sim", "control"))) {
    throw new Error("sim-eval ready.json 的 controlDir 与数据根不同源")
  }

  const dataRoot = await realpath(await runtimePath("data"))
  if (resolve(dataRoot) !== resolve(ready.dataRoot)) {
    throw new Error("sim-eval ready.json 的 dataRoot 与宿主实际加载的数据根不一致")
  }

  return {
    runDir,
    dataRoot,
    controlDir: ready.controlDir,
    seedPath: join(runDir, SIM_EVAL_SEED_FILE),
    seedReportPath: join(runDir, SIM_EVAL_SEED_REPORT_FILE),
    clockPath: join(runDir, SIM_CLOCK_FILE),
    // 评测运行必须有固定时钟：没有时钟就没有可复现的跨天/间隔判定，宁可启动失败。
    clock: await readSimClockFile(join(runDir, SIM_CLOCK_FILE)),
    generation: ready.generation,
    hostPid: ready.pid,
    ready,
  }
}

let cached: Promise<SimEvalRunContext | null> | null = null

/** 当前进程的评测上下文；普通开发运行（未设入口变量）返回 null。 */
export function getSimEvalRunContext(): Promise<SimEvalRunContext | null> {
  cached ??= isSimEvalRequested() ? loadSimEvalRunContext() : Promise.resolve(null)
  return cached
}
