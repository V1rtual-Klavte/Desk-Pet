// ==========================================
// 助手模式工具：打开应用 (NORMAL)
// ==========================================

import type { ToolDef } from "../types"
import { register } from "../registry"
import { invoke } from "@tauri-apps/api/core"
import { createLogger } from "@/services/logger"

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
  safetyLevel: "NORMAL",
  source: "local",
  sourceId: "",
  mode: "assistant",
  timeoutMs: 10000,
  personalityHint: {
    executing: "帮你打开...",
    done: "打开了～",
  },
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
      const msg = e instanceof Error ? e.message : String(e)
      return { success: false, content: "", error: msg }
    }
  },
}

export function registerAppOpenTool(): void {
  register(appOpenTool)
  log.info("应用打开工具已注册 (app.open)")
}
