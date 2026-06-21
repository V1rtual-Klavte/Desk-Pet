// ==========================================
// 助手模式工具：剪贴板 (NORMAL/DANGER)
// ==========================================

import type { ToolDef } from "../types"
import { register } from "../registry"
import { invoke } from "@tauri-apps/api/core"
import { createLogger } from "@/services/logger"

const log = createLogger("ToolClip")

const clipboardReadTool: ToolDef = {
  id: "local-clipboard-read",
  name: "clipboard_read",
  description: "读取系统剪贴板的文本内容。助手模式专用。",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  safetyLevel: "NORMAL",
  source: "local",
  sourceId: "",
  mode: "assistant",
  timeoutMs: 5000,
  async handler() {
    try {
      const result = await invoke<{ text: string }>("clipboard_read")
      return { success: true, content: result.text || "(剪贴板为空)" }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { success: false, content: "", error: msg }
    }
  },
}

const clipboardWriteTool: ToolDef = {
  id: "local-clipboard-write",
  name: "clipboard_write",
  description: "将文本写入系统剪贴板。助手模式专用，每次需确认。",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "要写入剪贴板的文本" },
    },
    required: ["text"],
  },
  safetyLevel: "DANGER",
  source: "local",
  sourceId: "",
  mode: "assistant",
  timeoutMs: 5000,
  async handler(params) {
    try {
      await invoke("clipboard_write", { text: params.text })
      return { success: true, content: "已写入剪贴板" }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { success: false, content: "", error: msg }
    }
  },
}

export function registerClipboardTools(): void {
  register(clipboardReadTool)
  register(clipboardWriteTool)
  log.info("剪贴板工具已注册 (clipboard.read/write)")
}
