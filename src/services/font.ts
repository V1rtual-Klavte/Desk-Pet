// ==========================================
// 全局字体 —— 系统字体枚举（Node 侧）
//
// 字体不随 Profile：唯一的真值在 CONFIG 的 appearance.font（appearanceConfig）。
// 本模块只提供系统字体列表（Rust `list_system_fonts` 的 Node 取用口），不持第二份状态。
// 原生 UI 的字体走 `apply_font_snapshot` 推送（native-ui/pushes.ts）。
// ==========================================

import { getHostBridge } from "@/services/host"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("Font")

let cachedFonts: string[] | null = null

/** 系统字体列表（排序去重的家族名）。同一窗口内缓存：设置页重复打开不重复全盘扫描。 */
export async function listSystemFonts(): Promise<string[]> {
  if (cachedFonts) return cachedFonts
  try {
    cachedFonts = await getHostBridge().request("list_system_fonts", {})
    return cachedFonts
  } catch (e) {
    log.error("枚举系统字体失败，字体下拉将为空:", formatError(e))
    return []
  }
}
