// ==========================================
// 本地工具：窗口信息 (SAFE)
//
// 只读 window/listener.ts 缓存的最近一次 `window-changed`：不自己挂监听、不建第二份缓存。
// 载荷里没有时间字段，`observedAt` 是宿主收报文时打的时间戳（见 WindowChangeSnapshot）。
// ==========================================

import type { ToolDef } from "../types"
import { TOOL_POLICY_VERSION } from "../types"
import { defineTool } from "../policy"
import { register } from "../registry"
import { getLastWindowChange } from "@/services/window"
import { windowMonitorConfig } from "@/services/config"
import { createLogger } from "@/services/logger"

const log = createLogger("ToolWin")

const windowInfoTool: ToolDef = defineTool({
  id: "local-window-info",
  name: "window_info",
  description: "获取最近一次窗口变化：窗口标题、内容与观测时间。窗口监控未开启或尚未收到事件时如实说明。",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  safetyLevel: "SAFE",
  source: "local",
  sourceId: "",
  actionCategory: "os.info",
  policy: {
    version: TOOL_POLICY_VERSION,
    permission: { defaultDecision: "allow" },
    execution: { effect: "read", isolation: "shared_read", replay: "never" },
    context: { resultProjection: "reference", historyCompaction: "summarize" },
  },
}, async () => {
  if (!windowMonitorConfig.enabled) {
    return { success: true, content: "窗口监控未开启（ai.windowMonitor.enabled = false），没有窗口信息可读。" }
  }
  const snapshot = getLastWindowChange()
  if (!snapshot) {
    return { success: true, content: "窗口监控已开启，但尚未收到窗口变化事件。" }
  }

  // 与提示词侧的当前时间同形（本地时区、分钟精度），便于模型直接和注入的当前时间比较。
  const at = new Date(snapshot.observedAt)
  const pad = (value: number) => String(value).padStart(2, "0")
  const observedAt = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} `
    + `${pad(at.getHours())}:${pad(at.getMinutes())}`

  const text = [
    `窗口标题: ${snapshot.title || "(空)"}`,
    `窗口内容: ${snapshot.content || "(空)"}`,
    `观测时间: ${observedAt}`,
  ].join("\n")

  return { success: true, content: text }
})

export function registerWindowInfoTool(): void {
  register(windowInfoTool)
  log.info("窗口信息工具已注册 (os.info)")
}
