// ==========================================
// 本地工具：网页抓取（DeepSeek Fetch 后端）
// ==========================================

import type { ToolDef } from "../types"
import { TOOL_POLICY_VERSION } from "../types"
import { defineTool } from "../policy"
import { register } from "../registry"
import { aiConfig } from "@/services/config"
import { createLogger } from "@/services/logger"
import { runWebFetch } from "./webfetch-core"
import { urlForLog } from "../log-url"

const log = createLogger("ToolWebFetch")

export const webFetchTool: ToolDef = defineTool({
  id: "local-web-fetch",
  name: "web_fetch",
  description:
    "抓取一个公开网页并返回 Markdown 正文；适合读文档、文章与公开页面。不执行页面脚本，也访问不了需要登录的内容。",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "要抓取的 http/https 公开网页地址" },
    },
    required: ["url"],
  },
  safetyLevel: "NORMAL",
  source: "local",
  sourceId: "",
  actionCategory: "net.fetch",
  policy: {
    version: TOOL_POLICY_VERSION,
    permission: { defaultDecision: "allow" },
    execution: { effect: "read", isolation: "shared_read", replay: "never", timeoutMs: 20_000 },
    context: { resultProjection: "reference", historyCompaction: "summarize" },
  },
}, async (params, ctx) => {
  const provider = aiConfig.provider
  if (provider !== "deepseek") {
    return {
      success: false,
      content: "",
      error: `网页抓取当前只支持 DeepSeek Fetch（当前 provider=${provider}）`,
      errorCode: "failed",
    }
  }
  if (!aiConfig.endpoint) {
    return { success: false, content: "", error: "未配置模型服务 endpoint，无法调用网页抓取", errorCode: "failed" }
  }
  if (!aiConfig.apiKey) {
    return { success: false, content: "", error: "未配置 DeepSeek API Key，无法调用网页抓取", errorCode: "failed" }
  }
  log.debug("网页抓取:", urlForLog(params.url))
  return runWebFetch(params, {
    fetch: (input, init) => globalThis.fetch(input, init),
    endpoint: aiConfig.endpoint,
    apiKey: aiConfig.apiKey,
    signal: ctx.signal,
  })
})

export function registerWebFetchTool(): void {
  register(webFetchTool)
  log.info("网页抓取工具已注册 (web_fetch)")
}
