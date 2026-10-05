// ==========================================
// 本地工具：截图 (SAFE)
//
// 采集走 Rust 的 capture_screenshot（前台窗口、长边 ≤1280），落盘走 save_screenshot
// （数据根 screenshots/，原子写 + 只保留最新 200 个）。隐私总闸是 ai.silentAccess.enabled：
// 关闭时返回中性说明而不是报错（与 window_info 同一口径），Rust 侧还复检一次同一开关。
// show_to_user=true 时把落盘路径放进 details，由运行内核并入本回合提交的助手条目。
// ==========================================

import type { ToolDef } from "../types"
import { TOOL_POLICY_VERSION } from "../types"
import { defineTool } from "../policy"
import { register } from "../registry"
import { getHostBridge } from "@/services/host"
import { silentAccessConfig } from "@/services/config"
import { createLogger } from "@/services/logger"
import { errorCode, formatError } from "@/services/error"
import { SCREENSHOT_TOOL_NAME } from "./screenshot-details"

const log = createLogger("ToolShot")

/** `capture_screenshot` 的回执（HostCommandMap 复用本类型，见 @/services/host）。 */
export interface CaptureScreenshotResult {
  data: string
  mimeType: string
  width: number
  height: number
}

/** `save_screenshot` 的回执（HostCommandMap 复用本类型，见 @/services/host）。 */
export interface SavedScreenshotResult {
  path: string
}

/** 隐私总闸关闭时的中性说明：不是错误，也不谎称截了图。 */
const GATE_CLOSED_TEXT = "静默访问未开启（ai.silentAccess.enabled = false），不能截取屏幕画面。"

const screenshotTool: ToolDef = defineTool({
  id: "local-screenshot",
  name: SCREENSHOT_TOOL_NAME,
  description: "截取当前屏幕画面（前台窗口；桌宠自己是前台时截主显示器整屏）。默认只供你查看；show_to_user=true 时同时展示在聊天里给用户看。静默访问关闭时不可用。",
  parameters: {
    type: "object",
    properties: {
      show_to_user: { type: "boolean", description: "是否把这张截图展示在聊天里给用户看（默认 false，只给你自己看）" },
    },
    required: [],
  },
  safetyLevel: "SAFE",
  source: "local",
  sourceId: "",
  actionCategory: "os.info",
  // 写出一份 PNG（本地变更），与其它效果操作互斥；不重放。
  policy: {
    version: TOOL_POLICY_VERSION,
    permission: { defaultDecision: "allow" },
    execution: { effect: "local_mutation", isolation: "exclusive_effect", replay: "never" },
    context: { resultProjection: "reference", historyCompaction: "summarize" },
  },
}, async (params) => {
  if (!silentAccessConfig.enabled) {
    return { success: true, content: GATE_CLOSED_TEXT }
  }
  const showToUser = params.show_to_user === true
  try {
    const shot = await getHostBridge().request("capture_screenshot", {})
    const saved = await getHostBridge().request("save_screenshot", { imageBase64: shot.data })
    const text = showToUser
      ? `已截取当前前台窗口画面（${shot.width}×${shot.height}），这张截图会展示在聊天里给用户看。`
      : `已截取当前前台窗口画面（${shot.width}×${shot.height}），仅供你查看。`
    return {
      success: true,
      content: text,
      // 模型自己也看得见这张图：文本 + 图片结果块（与 read 工具读图片同一条 Pi 原生形态）。
      contentParts: [
        { type: "text", text },
        { type: "image", data: shot.data, mimeType: shot.mimeType },
      ],
      details: { screenshotPath: saved.path, showToUser },
    }
  } catch (error) {
    if (errorCode(error) === "CANCELLED") {
      // Rust 侧隐私总闸在竞态窗口先于前端配置关闭：按同一条中性说明处理，不当成失败。
      return { success: true, content: GATE_CLOSED_TEXT }
    }
    log.warn("截图失败:", formatError(error))
    return { success: false, content: "", error: `截图失败：${formatError(error)}` }
  }
})

export function registerScreenshotTool(): void {
  register(screenshotTool)
  log.info("截图工具已注册 (os.info)")
}
