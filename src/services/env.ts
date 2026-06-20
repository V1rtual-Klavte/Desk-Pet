// ==========================================
// 全局环境变量 —— 平台检测 + 运行时配置
// 引入此文件即完成自动检测，无需手动初始化
// ==========================================

import { createLogger } from "@/services/logger";

const log = createLogger("Env");

/** 运行平台 */
export type Platform = "windows" | "macos" | "linux" | "unknown";

/** 检测当前 OS 平台 */
function detectPlatform(): Platform {
  // Tauri 环境：优先用 window.__TAURI_INTERNALS__ 判断
  if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
    // 通过 userAgent 检测（Tauri WebView 保留原始 UA）
    const ua = navigator.userAgent;
    if (/Windows/i.test(ua)) return "windows";
    if (/Mac/i.test(ua)) return "macos";
    if (/Linux/i.test(ua)) return "linux";
  }
  // 浏览器 fallback
  if (typeof navigator !== "undefined") {
    const p = navigator.platform?.toLowerCase() || "";
    if (p.includes("win")) return "windows";
    if (p.includes("mac")) return "macos";
    if (p.includes("linux")) return "linux";
  }
  return "unknown";
}

/** 是否为开发环境 */
function detectDev(): boolean {
  return import.meta.env.DEV === true;
}

// ==========================================
// 导出 —— 模块加载时自动执行一次
// ==========================================

export const platform: Platform = detectPlatform();
export const isWindows = platform === "windows";
export const isMacOS = platform === "macos";
export const isLinux = platform === "linux";
export const isDev = detectDev();

/** 窗口监控是否可用（当前仅 Windows 支持原生窗口标题捕获） */
export const windowMonitorAvailable = isWindows;

/** 跨显示器检测是否可用 */
export const crossMonitorAvailable = isWindows;

// 打印检测结果（开发环境）
if (isDev) {
  log.info("平台:", platform, "| 窗口监控:", windowMonitorAvailable);
}
