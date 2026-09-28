// ==========================================
// 本地工具：剪贴板 (DANGER)
// ==========================================

import type { ToolDef } from "../types"
import { TOOL_POLICY_VERSION } from "../types"
import { defineTool } from "../policy"
import { register } from "../registry"
import { invoke } from "@tauri-apps/api/core"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("ToolClip")

const clipboardReadTool: ToolDef = defineTool({
  id: "local-clipboard-read",
  name: "clipboard_read",
  description: "读取系统剪贴板的文本内容。",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  safetyLevel: "DANGER",
  source: "local",
  sourceId: "",
  actionCategory: "clip.read",
  // 隐私边界由风险维度与总策略给出：工具侧不额外表态。
  // 读取对象易变，只共享慢读取的并发额度，不做任何重放。
  policy: {
    version: TOOL_POLICY_VERSION,
    permission: { defaultDecision: "passthrough" },
    execution: { effect: "read", isolation: "shared_read", replay: "never" },
    context: { resultProjection: "reference", historyCompaction: "summarize" },
  },
}, async () => {
  try {
    const result = await invoke<{ text: string }>("clipboard_read")
    return { success: true, content: result.text || "(剪贴板为空)" }
  } catch (e) {
    const msg = formatError(e)
    return { success: false, content: "", error: msg }
  }
})

const clipboardWriteTool: ToolDef = defineTool({
  id: "local-clipboard-write",
  name: "clipboard_write",
  description: "将文本写入系统剪贴板。",
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
  actionCategory: "clip.write",
  policy: {
    version: TOOL_POLICY_VERSION,
    permission: { defaultDecision: "passthrough" },
    execution: { effect: "local_mutation", isolation: "exclusive_effect", replay: "never" },
    context: { resultProjection: "preserve", historyCompaction: "summarize" },
  },
}, async (params) => {
  try {
    await invoke("clipboard_write", { text: params.text })
    return { success: true, content: "已写入剪贴板" }
  } catch (e) {
    const msg = formatError(e)
    return { success: false, content: "", error: msg }
  }
})

export function registerClipboardTools(): void {
  register(clipboardReadTool)
  register(clipboardWriteTool)
  log.info("剪贴板工具已注册 (clipboard.read/write)")
}
