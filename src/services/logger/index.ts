// ==========================================
// 统一日志工具
// 所有日志同时输出到：
//   1. Rust 终端 + 日志文件（经 Tauri invoke 批量转发）
//   2. 浏览器 DevTools Console（开发时备用）
//
// 级别策略（优先级由高到低）：
//   VITE_LOG_LEVEL 显式覆写 > dev 一律 debug > 生产读配置
// 实际生效级别由 config.ts 的 computeLogLevel() 算好后 setLogLevel() 注入。
// 本模块刻意不 import config —— 否则 config 想用 logger 打日志就会成环。
//
// 用法：
//   import { createLogger } from "@/services/logger";
//   const log = createLogger("AI");
//   log.info("已初始化");    // → [12:34:56.789] INFO  [AI] 已初始化
//   log.warn("重试中...");  // → [12:34:57.123] WARN  [AI] 重试中...
//   log.error("失败", e);   // → [12:34:58.456] ERROR [AI] 失败 Error: ...
// ==========================================

import { invoke } from "@tauri-apps/api/core"
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

const ENV_LEVEL = import.meta.env.VITE_LOG_LEVEL as Level | undefined

let currentLevel: Level =
  ENV_LEVEL && LEVELS.includes(ENV_LEVEL)
    ? ENV_LEVEL
    : import.meta.env.DEV
      ? "debug"
      : "info"

/** 由 config.ts 的 computeLogLevel() 计算后注入 */
export function setLogLevel(level: Level): void {
  currentLevel = level
}

export function getLogLevel(): Level {
  return currentLevel
}

// 开发期挂到 window，便于在 DevTools 里手动切级别验证过滤行为
if (import.meta.env.DEV && typeof window !== "undefined") {
  ;(window as unknown as Record<string, unknown>).__logger = { setLogLevel, getLogLevel }
}

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

/** 把队列整批发给 Rust，保持入队顺序。窗口关闭前也会调用，保证不丢尾部日志。 */
export function flushLogs(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (!pending.length) return
  const msgs = pending.splice(0, pending.length)
  invoke("log_messages", { msgs }).catch((e) => {
    // 必须用 console：走 logger 会递归
    console.warn("[Logger] 转发 Rust 失败 (Tauri 未就绪?)", formatError(e))
  })
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
      const l = line("DEBUG", msg, args)
      console.debug(l)
      toRust("debug", l)
    },
    info(msg: string, ...args: unknown[]) {
      if (!enabled("info")) return
      const l = line("INFO ", msg, args)
      console.info(l)
      toRust("info", l)
    },
    warn(msg: string, ...args: unknown[]) {
      if (!enabled("warn")) return
      const l = line("WARN ", msg, args)
      console.warn(l)
      toRust("warn", l)
    },
    error(msg: string, ...args: unknown[]) {
      // error 永远输出，不受 level 限制
      const l = line("ERROR", msg, args)
      console.error(l)
      toRust("error", l)
    },
  }
}
