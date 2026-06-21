// ==========================================
// 本地工具：HTTP GET (NORMAL)
// 获取网页内容
// ==========================================

import type { ToolDef } from "../types"
import { register } from "../registry"
import { createLogger } from "@/services/logger"

const log = createLogger("ToolHttp")

const httpTool: ToolDef = {
  id: "local-http-get",
  name: "http_get",
  description: "通过 HTTP GET 获取指定 URL 的网页内容。返回纯文本。",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "目标 URL（需以 http:// 或 https:// 开头）" },
    },
    required: ["url"],
  },
  safetyLevel: "NORMAL",
  source: "local",
  sourceId: "",
  mode: "pet",
  timeoutMs: 20000,
  personalityHint: {
    executing: "帮你上网查查...",
    done: "查到了～",
  },
  async handler(params) {
    const url = String(params.url)

    // 基础安全检查
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return { success: false, content: "", error: "URL 必须以 http:// 或 https:// 开头" }
    }

    // 禁止内网地址
    try {
      const u = new URL(url)
      const blockedHosts = ["localhost", "127.0.0.1", "0.0.0.0", "::1"]
      if (blockedHosts.includes(u.hostname)) {
        return { success: false, content: "", error: "不允许访问内网地址" }
      }
    } catch {
      return { success: false, content: "", error: "无效的 URL" }
    }

    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "DeskPet/1.0" },
      })
      if (!res.ok) {
        return { success: false, content: "", error: `HTTP ${res.status} ${res.statusText}` }
      }
      const ct = res.headers.get("content-type") || ""
      if (!ct.includes("text") && !ct.includes("json") && !ct.includes("xml")) {
        return { success: false, content: "", error: `不支持的 Content-Type: ${ct}` }
      }
      const text = await res.text()
      const truncated = text.length > 8000
        ? text.substring(0, 8000) + "\n...(内容已截断)"
        : text
      return { success: true, content: truncated }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { success: false, content: "", error: msg }
    }
  },
}

export function registerHttpTool(): void {
  register(httpTool)
  log.info("HTTP 工具已注册 (http.get)")
}
