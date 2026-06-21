// ==========================================
// 本地工具：文件读取/列表/搜索 (SAFE)
// 轻量 + 助手模式均可用
// ==========================================

import type { ToolDef } from "../types"
import { register } from "../registry"
import { invoke } from "@tauri-apps/api/core"
import { createLogger } from "@/services/logger"

const log = createLogger("ToolFile")

// ── file.read ──

const fileReadTool: ToolDef = {
  id: "local-file-read",
  name: "file_read",
  description: "读取指定路径的文本文件内容。用于查看文件。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件的绝对路径" },
    },
    required: ["path"],
  },
  safetyLevel: "SAFE",
  source: "local",
  sourceId: "",
  mode: "pet",
  personalityHint: {
    executing: "让我读读这个文件...",
    done: "读完啦～",
    blocked: "唔…这个文件不能读呢～",
  },
  async handler(params) {
    try {
      const result = await invoke<{ content: string; size: number }>("file_read", {
        path: params.path,
      })
      const preview = result.content.length > 3000
        ? result.content.substring(0, 3000) + "\n...(内容已截断)"
        : result.content
      return { success: true, content: preview }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { success: false, content: "", error: msg }
    }
  },
}

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
  personalityHint: {
    executing: "让我看看这里面有什么...",
    done: "看到了～",
    blocked: "这个目录不能看哦～",
  },
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
      const msg = e instanceof Error ? e.message : String(e)
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
  personalityHint: {
    executing: "帮你找找...",
    done: "找到了！",
  },
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
      const msg = e instanceof Error ? e.message : String(e)
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
  register(fileReadTool)
  register(fileListTool)
  register(fileSearchTool)
  log.info("文件工具已注册 (file.read/list/search)")
}
