// ==========================================
// 统一日志工具
// 所有日志经 HostBridge 批量转发进 Rust 日志内核（`logger.rs` 的 `emit_frontend`
// → **终端 + 文件**双出口，与 Rust 日志汇成同一条时间线）。
//
// **不再同时写进程 console**（2026-10-07）：集成运行时子进程的 stdout/stderr 由
// 监督器的 stdio 采集器采集进同一份 Rust 日志 —— console 那一路会被二次采集，
// 同一条日志进文件两次。采集器保留：裸 stderr / 崩溃输出仍靠它兜底。
//
// 级别策略（优先级由高到低）：
//   开发模式一律 debug > 生产读配置（判据来自宿主运行模式端口，见 @/services/host）
// 实际生效级别由 config.ts 的 computeLogLevel() 算好后 setLogLevel() 注入。
// 本模块刻意不 import config —— 否则 config 想用 logger 打日志就会成环。
//
// 用法：
//   import { createLogger } from "@/services/logger";
//   const log = createLogger("AI");
//   log.info("已初始化");    // → [12:34:56.789] INFO  [AI] 已初始化
//   log.warn("重试中...");  // → [12:34:57.123] WARN  [AI] 重试中...
//   log.error("失败", e);   // → [12:34:58.456] ERROR [AI] 失败 Error: ...
//
// 本文件里的 console.*（仅 flushLogs 的转发失败兜底）是全仓唯一合法的 console
// 调用点：logger 自身的失败没有第二个日志出口，其它模块一律经 createLogger
//（AGENTS.md 禁止直接 console.*）[保留已登记 §4.2]
// ==========================================

import { getHostBridge, type HostBridge } from "@/services/host"
import { formatError } from "@/services/error/format"

export type Level = "debug" | "info" | "warn" | "error"

export const LEVELS: readonly Level[] = ["debug", "info", "warn", "error"]

/** 与 Rust `logger::LEVEL_*` 对齐 */
export const LEVEL_ORDER: Record<Level, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

const FLUSH_MS = 60
const MAX_BUFFER = 32

// 初始级别取保守的 info：真实级别由 config.ts 的 computeLogLevel() 在引导期算好后经
// setLogLevel() 注入（开发模式判据来自宿主运行模式端口）。模块加载早于端口注入与配置
// 读取，这里不主动查询、也不读 import.meta.env。
let currentLevel: Level = "info"

/** 由 config.ts 的 computeLogLevel() 计算后注入 */
export function setLogLevel(level: Level): void {
  currentLevel = level
}

export function getLogLevel(): Level {
  return currentLevel
}

// logger 模块本身不感知构建环境。

/** 格式化时间戳 HH:MM:SS.mmm */
function ts(): string {
  const d = new Date()
  return (
    String(d.getHours()).padStart(2, "0") +
    ":" +
    String(d.getMinutes()).padStart(2, "0") +
    ":" +
    String(d.getSeconds()).padStart(2, "0") +
    "." +
    String(d.getMilliseconds()).padStart(3, "0")
  )
}

/** 检查是否满足当前日志级别 */
function enabled(level: Level): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel]
}

/** 单个参数转文本：Error 保留 stack 便于定位，其余走统一归一化 */
function fmtOne(value: unknown): string {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`
  return formatError(value)
}

/** 格式化参数 */
function fmtArgs(args: unknown[]): string {
  if (!args.length) return ""
  return " " + args.map(fmtOne).join(" ")
}

// ── 批量转发 ──
// 逐行 invoke 会在窗口监控这类高频场景产生大量 IPC 往返，所以攒批。
// 必须是**单一 FIFO 队列**：按级别分桶会让不同级别的批各自 flush，同一窗口内
// 的日志在文件里乱序（时间戳正确但物理顺序错位）。级别过滤已在上面的 enabled()
// 完成，Rust 侧无需再分流。

const pending: string[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let flushTail: Promise<void> = Promise.resolve()
let allFlushesSucceeded = true

/** 把队列整批发给宿主，保持入队顺序。进程退出前也会调用，保证不丢尾部日志。 */
export function flushLogs(): Promise<boolean> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (!pending.length) return flushTail.then(() => allFlushesSucceeded)
  const msgs = pending.splice(0, pending.length)
  // 串行发送保住批次 FIFO；resolve boolean 供关停报告使用，普通定时 flush 仍不抛异常。
  const operation = flushTail.then(async () => {
    try {
      const bridge: HostBridge = getHostBridge()
      await bridge.request("log_messages", { msgs })
      return true
    } catch (e) {
      allFlushesSucceeded = false
      // 必须用 console：走 logger 会递归 [保留已登记 §4.2]
      console.warn("[Logger] 转发原生宿主失败", formatError(e))
      return false
    }
  })
  flushTail = operation.then(() => undefined)
  return operation.then(() => allFlushesSucceeded)
}

function toRust(level: Level, line: string): void {
  pending.push(line)
  // error 触发立即 flush —— 整队发出，既保序又不会因缓冲丢掉错误日志
  if (level === "error" || pending.length >= MAX_BUFFER) {
    flushLogs()
  } else if (flushTimer === null) {
    flushTimer = setTimeout(flushLogs, FLUSH_MS)
  }
}

if (typeof window !== "undefined") {
  // 窗口关闭/刷新时把缓冲冲出去，否则最后几行日志会丢
  window.addEventListener("pagehide", flushLogs)
  window.addEventListener("beforeunload", flushLogs)
}

export interface Logger {
  debug(msg: string, ...args: unknown[]): void
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
}

/**
 * 创建一个带前缀的日志记录器
 * @param prefix 模块前缀，如 "AI"、"WinMon"、"Rust"
 */
export function createLogger(prefix: string): Logger {
  function line(level: string, msg: string, args: unknown[]): string {
    return `[${ts()}] ${level} [${prefix}] ${msg}${fmtArgs(args)}`
  }

  return {
    debug(msg: string, ...args: unknown[]) {
      if (!enabled("debug")) return
      toRust("debug", line("DEBUG", msg, args))
    },
    info(msg: string, ...args: unknown[]) {
      if (!enabled("info")) return
      toRust("info", line("INFO ", msg, args))
    },
    warn(msg: string, ...args: unknown[]) {
      if (!enabled("warn")) return
      toRust("warn", line("WARN ", msg, args))
    },
    error(msg: string, ...args: unknown[]) {
      // error 永远输出，不受 level 限制
      toRust("error", line("ERROR", msg, args))
    },
  }
}
