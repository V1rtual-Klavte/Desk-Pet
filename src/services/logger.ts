// ==========================================
// 统一日志工具
// 所有日志同时输出到：
//   1. Rust 终端（通过 Tauri invoke 转发）
//   2. 浏览器 DevTools Console（开发时备用）
//
// 用法：
//   import { createLogger } from "@/services/logger";
//   const log = createLogger("AI");
//   log.info("已初始化");    // → [12:34:56.789] INFO  [AI] 已初始化
//   log.warn("重试中...");  // → [12:34:57.123] WARN  [AI] 重试中...
//   log.error("失败", e);   // → [12:34:58.456] ERROR [AI] 失败 Error: ...
// ==========================================

import { invoke } from "@tauri-apps/api/core";
import { loggingConfig } from "./config";

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** 格式化时间戳 HH:MM:SS.mmm */
function ts(): string {
  const d = new Date();
  return (
    String(d.getHours()).padStart(2, "0") +
    ":" +
    String(d.getMinutes()).padStart(2, "0") +
    ":" +
    String(d.getSeconds()).padStart(2, "0") +
    "." +
    String(d.getMilliseconds()).padStart(3, "0")
  );
}

/** 检查是否满足当前日志级别 */
function enabled(level: Level): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[loggingConfig.level];
}

/** 格式化参数，Error 对象特殊处理 */
function fmtArgs(args: unknown[]): string {
  if (!args.length) return "";
  return (
    " " +
    args
      .map((a) => {
        if (a instanceof Error) return a.message || a.toString();
        if (typeof a === "string") return a;
        try { return JSON.stringify(a); } catch { return String(a); }
      })
      .join(" ")
  );
}

/** 发送一行日志到 Rust 终端 */
function toRust(line: string): void {
  invoke("log_message", { msg: line }).catch(() => {});
}

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

/**
 * 创建一个带前缀的日志记录器
 * @param prefix 模块前缀，如 "AI"、"WinMon"、"Rust"
 */
export function createLogger(prefix: string): Logger {
  function line(level: string, msg: string, args: unknown[]): string {
    return `[${ts()}] ${level} [${prefix}] ${msg}${fmtArgs(args)}`;
  }

  return {
    debug(msg: string, ...args: unknown[]) {
      if (!enabled("debug")) return;
      const l = line("DEBUG", msg, args);
      console.debug(l);
      toRust(l);
    },
    info(msg: string, ...args: unknown[]) {
      if (!enabled("info")) return;
      const l = line("INFO ", msg, args);
      console.info(l);
      toRust(l);
    },
    warn(msg: string, ...args: unknown[]) {
      if (!enabled("warn")) return;
      const l = line("WARN ", msg, args);
      console.warn(l);
      toRust(l);
    },
    error(msg: string, ...args: unknown[]) {
      // error 永远输出，不受 level 限制
      const l = line("ERROR", msg, args);
      console.error(l);
      toRust(l);
    },
  };
}
