// ==========================================
// 助手模式工具：打开应用 (DANGER)
//
// 这是唯一把用户可控字符串交给操作系统去执行的工具（macOS 走 `open`，
// Windows 走 ShellExecuteW），路径可指向任意已存在文件，所以按 DANGER 走确认。
// ==========================================

import type { ToolDef } from "../types"
import { register } from "../registry"
import { invoke } from "@tauri-apps/api/core"
import { loopConfig } from "@/services/config"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("ToolApp")

const appOpenTool: ToolDef = {
  id: "local-app-open",
  name: "app_open",
  description: "打开指定路径的应用程序或文件。助手模式专用。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "应用程序或文件的路径" },
    },
    required: ["path"],
  },
  safetyLevel: "DANGER",
  source: "local",
  sourceId: "",
  mode: "assistant",
  timeoutMs: loopConfig.toolTimeoutMs,
  actionCategory: "app.launch",
  async handler(params) {
    try {
      const result = await invoke<{ success: boolean }>("app_open", {
        path: params.path,
      })
      return {
        success: result.success,
        content: result.success ? `已打开: ${params.path}` : "",
        error: result.success ? undefined : "无法打开",
      }
    } catch (e) {
      const msg = formatError(e)
      return { success: false, content: "", error: msg }
    }
  },
}

export function registerAppOpenTool(): void {
  register(appOpenTool)
  log.info("应用打开工具已注册 (app.open)")
}
