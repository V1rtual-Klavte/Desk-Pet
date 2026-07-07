// ==========================================
// 助手模式工具：文件删除 (NOWAY)
// 默认硬禁止，即使助手模式也不允许
// ==========================================

import type { ToolDef } from "../types"
import { register } from "../registry"
import { loopConfig } from "@/services/config"
import { createLogger } from "@/services/logger"

const log = createLogger("ToolFDel")

const fileDeleteTool: ToolDef = {
  id: "local-file-delete",
  name: "file_delete",
  description: "删除指定路径的文件。此操作被硬禁止。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "要删除的文件绝对路径" },
    },
    required: ["path"],
  },
  safetyLevel: "NOWAY",
  source: "local",
  sourceId: "",
  mode: "assistant",
  timeoutMs: loopConfig.toolTimeoutMs,
  actionCategory: "fs.write",
  async handler() {
    return { success: false, content: "", error: "文件删除操作已被硬禁止" }
  },
}

export function registerFileDeleteTool(): void {
  register(fileDeleteTool)
  log.info("文件删除工具已注册 (file.delete, NOWAY)")
}
