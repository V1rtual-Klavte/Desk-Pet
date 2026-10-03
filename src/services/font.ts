// ==========================================
// 全局字体 —— 系统字体枚举 + CSS 变量注入
//
// 字体不随 Profile：唯一的真值在 CONFIG 的 appearance.font（appearanceConfig）。
// 本模块只做两件事：把设置注入 :root 变量、提供系统字体列表；不持有第二份状态。
// ==========================================

import { invoke } from "@tauri-apps/api/core"
import { appearanceConfig, DEFAULT_FONT_SIZE } from "@/services/config"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("Font")

/**
 * 系统默认字体栈：family 为空串时的落点。
 * 注入后 `--font-ui` 自带完整兜底，CSS 侧只需一个最简单的 fallback。
 */
export const SYSTEM_FONT_STACK =
  'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif'

/**
 * 把 CONFIG 的字体设置注入 :root CSS 变量（--font-ui / --font-size）。
 *
 * 每个窗口各自调用：启动时经 bootWindow，设置窗口保存后自己刷新，其余窗口
 * 经 deskpet-settings-saved 重读配置后再调用。字号缺省与改造前聊天文本的实际
 * 渲染值一致（改造前该变量无消费者，聊天文本由 clamp 上限决定）。
 */
export function applyFontVars(): void {
  const family = sanitizeFontFamily(appearanceConfig.fontFamily)
  const configured = appearanceConfig.fontSize
  const size = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_FONT_SIZE
  const root = document.documentElement
  root.style.setProperty("--font-ui", family ? `"${family}", ${SYSTEM_FONT_STACK}` : SYSTEM_FONT_STACK)
  root.style.setProperty("--font-size", `${size}px`)
}

/**
 * 去掉会截断 CSS 字符串的字符（引号/反斜杠/换行/分号/花括号）。
 * CONFIG 是用户可手写的 YAML，字体名进入 CSS 前必须清掉这些 ——
 * 一个引号就能让注入的整条声明失效。
 */
function sanitizeFontFamily(name: string): string {
  return name.replace(/["'\\\r\n;{}]/g, "").trim()
}

let cachedFonts: string[] | null = null

/** 系统字体列表（排序去重的家族名）。同一窗口内缓存：设置页重复打开不重复全盘扫描。 */
export async function listSystemFonts(): Promise<string[]> {
  if (cachedFonts) return cachedFonts
  try {
    cachedFonts = await invoke<string[]>("list_system_fonts")
    return cachedFonts
  } catch (e) {
    log.error("枚举系统字体失败，字体下拉将为空:", formatError(e))
    return []
  }
}
