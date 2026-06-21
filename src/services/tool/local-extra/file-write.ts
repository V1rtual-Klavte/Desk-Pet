// ==========================================
// 助手模式工具：文件写入 (DANGER)
// 仅在助手模式下可用
// ==========================================

import type { ToolDef } from "../types"
import { register } from "../registry"
import { invoke } from "@tauri-apps/api/core"
import { createLogger } from "@/services/logger"

const log = createLogger("ToolFWrite")

const fileWriteTool: ToolDef = {
  id: "local-file-write",
  name: "file_write",
  description: "写入内容到指定路径的文件。助手模式专用。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件绝对路径" },
      content: { type: "string", description: "要写入的内容" },
    },
    required: ["path", "content"],
  },
  safetyLevel: "DANGER",
  source: "local",
  sourceId: "",
  mode: "assistant",
  timeoutMs: 15000,
  personalityHint: {
    executing: "帮你写下来...",
    done: "写好啦～",
    blocked: "唔…这个文件不能写呢～",
  },
  async handler(params) {
    try {
      const result = await invoke<{ success: boolean; error?: string }>("file_write", {
        path: params.path,
        content: params.content,
      })
      return {
        success: result.success,
        content: result.success ? `文件已写入: ${params.path}` : "",
        error: result.error,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { success: false, content: "", error: msg }
    }
  },
}

export function registerFileWriteTool(): void {
  register(fileWriteTool)
  log.info("文件写入工具已注册 (file.write)")
}
