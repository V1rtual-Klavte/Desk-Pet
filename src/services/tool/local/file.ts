// ==========================================
// 本地工具：文件列表/搜索 (SAFE)
// 轻量 + 助手模式均可用
// ==========================================

import type { ToolDef } from "../types"
import { register } from "../registry"
import { invoke } from "@tauri-apps/api/core"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("ToolFile")

// ── file.list ──

const fileListTool: ToolDef = {
  id: "local-file-list",
  name: "file_list",
  description: "列出指定目录的文件和子目录。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "目录的绝对路径" },
    },
    required: ["path"],
  },
  safetyLevel: "SAFE",
  source: "local",
  sourceId: "",
  mode: "pet",
  actionCategory: "fs.read",
  async handler(params) {
    try {
      const result = await invoke<{ entries: { name: string; kind: string; size: number }[] }>("file_list", {
        path: params.path,
      })
      const listing = result.entries
        .map(e => `${e.kind === "dir" ? "📁" : "📄"} ${e.name}${e.kind === "file" ? ` (${formatSize(e.size)})` : ""}`)
        .join("\n")
      return { success: true, content: listing || "(空目录)" }
    } catch (e) {
      const msg = formatError(e)
      return { success: false, content: "", error: msg }
    }
  },
}

// ── file.search ──

const fileSearchTool: ToolDef = {
  id: "local-file-search",
  name: "file_search",
  description: "在指定目录中搜索文件名包含关键词的文件。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "搜索起始目录的绝对路径" },
      keyword: { type: "string", description: "文件名关键词" },
    },
    required: ["path", "keyword"],
  },
  safetyLevel: "SAFE",
  source: "local",
  sourceId: "",
  mode: "pet",
  actionCategory: "fs.read",
  async handler(params) {
    try {
      const result = await invoke<{ entries: { name: string; kind: string; size: number }[] }>("file_list", {
        path: params.path,
      })
      const keyword = String(params.keyword).toLowerCase()
      const matched = result.entries.filter(e => e.name.toLowerCase().includes(keyword))
      const listing = matched.length > 0
        ? matched.map(e => `${e.kind === "dir" ? "📁" : "📄"} ${e.name}${e.kind === "file" ? ` (${formatSize(e.size)})` : ""}`).join("\n")
        : `在 ${params.path} 中未找到包含 "${params.keyword}" 的文件`
      return { success: true, content: listing }
    } catch (e) {
      const msg = formatError(e)
      return { success: false, content: "", error: msg }
    }
  },
}

// ── 辅助 ──

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

// ── 注册 ──

export function registerFileTools(): void {
  register(fileListTool)
  register(fileSearchTool)
  log.info("文件工具已注册 (file.list/search)")
}
