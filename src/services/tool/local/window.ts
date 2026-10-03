// ==========================================
// 本地工具：窗口信息 (SAFE)
//
// 只读 window/listener.ts 缓存的最近一次原生 observation：不自己挂监听、不建第二份缓存。
// ==========================================

import type { ToolDef } from "../types"
import { TOOL_POLICY_VERSION } from "../types"
import { defineTool } from "../policy"
import { register } from "../registry"
import { getLatestWindowObservation } from "@/services/window"
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
  const snapshot = getLatestWindowObservation()
  if (!snapshot) {
    return { success: true, content: "窗口监控已开启，但尚未收到窗口观察。" }
  }

  // 与提示词侧的当前时间同形（本地时区、分钟精度），便于模型直接和注入的当前时间比较。
  const at = new Date(snapshot.observedAt)
  const pad = (value: number) => String(value).padStart(2, "0")
  const observedAt = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} `
    + `${pad(at.getHours())}:${pad(at.getMinutes())}`

  const text = [
    `应用: ${snapshot.app || "(未知)"}`,
    `应用标识: ${snapshot.appId || "(未知)"}`,
    `窗口标题: ${snapshot.title || "(空)"}`,
    `观察状态: ${snapshot.observationState}`,
    `系统空闲时长: ${snapshot.idleForMs ?? "未知"} ms`,
    `观测时间: ${observedAt}`,
  ].join("\n")

  return { success: true, content: text }
})

export function registerWindowInfoTool(): void {
  register(windowInfoTool)
  log.info("窗口信息工具已注册 (os.info)")
}
