// ==========================================
// sim-eval 固定时钟 — 只改 Node 领域时间
// ==========================================
//
// 评测运行根里由执行器写下 clock.json；宿主 Node 在领域引导早期安装它，之后
// `Date.now()` / `new Date()` 返回「基准 + 真实流逝」。基准由驱动按用例时间推进，
// 因此跨天、间隔与本地日期判定可复现，而真实等待仍按真实时间流逝。
//
// 边界（契约 W5）：
//   - 只覆盖本进程的 Date；Rust 调度器、OS 文件时间与跨进程时间戳仍是真实时间，
//     不能据此声称「真实间隔已验证」。
//   - 时区由执行器用 `TZ` 固定（整小时偏移 → `Etc/GMT±N`），这里只核对实际生效值。
//   - 同一进程内模拟时间单调不减：推进基准早于当前模拟时刻时收敛到当前时刻。

import { readFile } from "node:fs/promises"

export const SIM_CLOCK_FILE = "clock.json"
export const SIM_CLOCK_SCHEMA_VERSION = 1

export interface SimClockFile {
  schemaVersion: number
  /** ISO 时间串，可带偏移；驱动按用例步骤推进。 */
  base: string
  /** 执行器设置的 `TZ` 期望值，例如 `Etc/GMT-8`（UTC+08:00）。 */
  timezone: string
  /** 固定该基准的原因，写入证据供审计。 */
  reason: string
}

export interface SimClockSnapshot {
  /** 当前模拟基准（ISO）。单调推进后可能晚于请求值。 */
  base: string
  /** 当前模拟时刻（ISO）。 */
  now: string
  timezone: string
  reason: string
}

const REAL_DATE = Date
let patched = false
let clock: { baseMs: number; realBase: number; timezone: string; reason: string } | null = null

function parseInstant(value: unknown, field: string): number {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`sim-eval clock.json 缺少字段 ${field}`)
  const ms = REAL_DATE.parse(value)
  if (!Number.isFinite(ms)) throw new Error(`sim-eval clock.json 的 ${field} 不是可解析时间：${value}`)
  return ms
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`sim-eval clock.json 缺少字段 ${field}`)
  return value
}

export function parseSimClockFile(raw: unknown): SimClockFile {
  if (typeof raw !== "object" || raw === null) throw new Error("sim-eval clock.json 不是对象")
  const record = raw as Record<string, unknown>
  if (record.schemaVersion !== SIM_CLOCK_SCHEMA_VERSION) {
    throw new Error(`sim-eval clock.json schemaVersion=${String(record.schemaVersion)} 不受支持`)
  }
  parseInstant(record.base, "base")
  return {
    schemaVersion: SIM_CLOCK_SCHEMA_VERSION,
    base: requiredText(record.base, "base"),
    timezone: requiredText(record.timezone, "timezone"),
    reason: requiredText(record.reason, "reason"),
  }
}

/** 读取并校验运行根下的 clock.json。 */
export async function readSimClockFile(path: string): Promise<SimClockFile> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    throw new Error(`sim-eval 缺少可读的 clock.json（${path}）：${error instanceof Error ? error.message : String(error)}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error(`sim-eval clock.json 不是合法 JSON：${path}`)
  }
  return parseSimClockFile(raw)
}

function simulatedNow(): number {
  if (!clock) return REAL_DATE.now()
  return clock.baseMs + (REAL_DATE.now() - clock.realBase)
}

function snapshot(): SimClockSnapshot {
  if (!clock) throw new Error("固定时钟尚未安装")
  return {
    base: new REAL_DATE(clock.baseMs).toISOString(),
    now: new REAL_DATE(simulatedNow()).toISOString(),
    timezone: clock.timezone,
    reason: clock.reason,
  }
}

/**
 * 安装固定时钟。必须是本进程第一次安装；重复调用只允许同一时区，
 * 基准交给 `setSimClockBase` 推进。
 */
export function installSimClock(file: SimClockFile): SimClockSnapshot {
  const resolvedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (resolvedTimezone !== file.timezone) {
    throw new Error(`sim-eval 固定时钟时区不一致：期望 ${file.timezone}，实际 ${resolvedTimezone}（检查执行器设置的 TZ）`)
  }
  const baseMs = parseInstant(file.base, "base")
  if (patched) {
    if (clock?.timezone !== file.timezone) throw new Error("固定时钟已安装为其它时区，不能重复安装")
    return setSimClockBase(file.base, file.reason)
  }

  clock = { baseMs, realBase: REAL_DATE.now(), timezone: file.timezone, reason: file.reason }
  const patchedDate = new Proxy(REAL_DATE, {
    apply: () => new REAL_DATE(simulatedNow()).toString(),
    construct: (target, args, newTarget) => {
      if (args.length === 0) return Reflect.construct(target, [simulatedNow()], newTarget)
      return Reflect.construct(target, args, newTarget)
    },
    get: (target, property, receiver) => {
      if (property === "now") return () => simulatedNow()
      return Reflect.get(target, property, receiver)
    },
  })
  globalThis.Date = patchedDate as DateConstructor
  patched = true
  return snapshot()
}

/**
 * 推进模拟基准；返回推进后的快照。
 *
 * 新基准早于当前模拟时刻时收敛到当前时刻，保证本进程内时间不回退。
 */
export function setSimClockBase(base: string, reason?: string): SimClockSnapshot {
  if (!clock) throw new Error("固定时钟尚未安装")
  const requested = parseInstant(base, "base")
  const now = simulatedNow()
  clock.baseMs = Math.max(requested, now)
  clock.realBase = REAL_DATE.now()
  if (reason) clock.reason = reason
  return snapshot()
}

/** 当前固定时钟快照；未安装时为 null。 */
export function getSimClockSnapshot(): SimClockSnapshot | null {
  return clock ? snapshot() : null
}

/** 当前模拟基准的毫秒值；未安装时为 null。 */
export function getSimClockBaseMs(): number | null {
  return clock ? clock.baseMs : null
}

/** 仅供测试：恢复真实 Date 与初始状态。 */
export function resetSimClockForTest(): void {
  if (patched) globalThis.Date = REAL_DATE
  patched = false
  clock = null
}
