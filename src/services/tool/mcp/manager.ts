// ==========================================
// MCP Manager —— 管理 MCP Server 连接
// Phase 4: 完整 stdio/SSE 实现
// 当前: Mock MCP 工具用于测试
// ==========================================

import type { ToolDef } from "@/services/tool/types"
import { createLogger } from "@/services/logger"

const log = createLogger("MCP")

// ── Mock MCP 工具 ──

const MOCK_MCP_TOOLS: ToolDef[] = [
  {
    id: "mcp-weather",
    name: "mcp_weather",
    description: "查询指定城市的天气信息。",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string", description: "城市名称，如 '北京'、'上海'" },
      },
      required: ["city"],
    },
    safetyLevel: "NORMAL",
    source: "mcp",
    sourceId: "mock-weather-server",
    mode: "assistant",
    timeoutMs: 10000,
    personalityHint: {
      executing: "让我查一下天气...",
      done: "查到了～",
    },
    async handler(params) {
      const city = String(params.city ?? "未知")
      const temps = ["☀️ 晴天 25°C", "⛅ 多云 22°C", "🌧️ 小雨 18°C", "❄️ 雪 -2°C"]
      const idx = (city.charCodeAt(0) || 0) % temps.length
      await new Promise(r => setTimeout(r, 100)) // 模拟网络延迟
      return {
        success: true,
        content: `[MCP Weather] ${city}: ${temps[idx]} (Mock 数据)`,
      }
    },
  },

  {
    id: "mcp-calculator",
    name: "mcp_calculator",
    description: "执行数学计算。支持加减乘除、幂、开方。",
    parameters: {
      type: "object",
      properties: {
        expression: { type: "string", description: "数学表达式，如 '2+3*4' 或 'sqrt(16)'" },
      },
      required: ["expression"],
    },
    safetyLevel: "SAFE",
    source: "mcp",
    sourceId: "mock-calc-server",
    mode: "assistant",
    timeoutMs: 5000,
    personalityHint: {
      executing: "让我算一下...",
      done: "算好了～",
    },
    async handler(params) {
      const expr = String(params.expression ?? "0")
      try {
        // 安全计算（简单数值运算，不涉及文件系统）
        const sanitized = expr.replace(/[^0-9+\-*/().%\s]|Math\./g, "")
        const result = Function(`"use strict"; return (${sanitized || "0"})`)()
        return { success: true, content: `[MCP Calculator] ${expr} = ${result}` }
      } catch {
        // 尝试 sqrt 等函数
        try {
          const withMath = expr.replace(/sqrt\(([^)]+)\)/g, "Math.sqrt($1)")
            .replace(/pow\(([^,]+),([^)]+)\)/g, "Math.pow($1,$2)")
          const result = Function(`"use strict"; return (${withMath})`)()
          return { success: true, content: `[MCP Calculator] ${expr} = ${result}` }
        } catch {
          return { success: false, content: "", error: `无法计算: ${expr}` }
        }
      }
    },
  },

  {
    id: "mcp-note",
    name: "mcp_note",
    description: "创建一条笔记。支持 Markdown 格式。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "笔记标题" },
        content: { type: "string", description: "笔记内容 (Markdown)" },
      },
      required: ["title", "content"],
    },
    safetyLevel: "NORMAL",
    source: "mcp",
    sourceId: "mock-note-server",
    mode: "assistant",
    timeoutMs: 10000,
    personalityHint: {
      executing: "帮你记下来...",
      done: "记好啦～",
    },
    async handler(params) {
      const title = String(params.title ?? "")
      const content = String(params.content ?? "")
      // 存到 localStorage（模拟 MCP notes server）
      const notes = JSON.parse(localStorage.getItem("deskpet_mcp_notes") || "[]") as { title: string; content: string; time: number }[]
      notes.push({ title, content, time: Date.now() })
      localStorage.setItem("deskpet_mcp_notes", JSON.stringify(notes.slice(-20)))
      return { success: true, content: `[MCP Notes] 已记录: "${title}" (共 ${notes.length} 条笔记)` }
    },
  },

  {
    id: "mcp-translate",
    name: "mcp_translate",
    description: "简单翻译。将文本翻译为指定语言（Mock 版，返回模拟结果）。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "要翻译的文本" },
        to: { type: "string", description: "目标语言，如 'en', 'ja', 'zh'", enum: ["en", "ja", "zh", "ko"] },
      },
      required: ["text", "to"],
    },
    safetyLevel: "SAFE",
    source: "mcp",
    sourceId: "mock-translate-server",
    mode: "assistant",
    timeoutMs: 10000,
    personalityHint: {
      executing: "帮你翻译一下...",
      done: "翻译好啦～",
    },
    async handler(params) {
      const text = String(params.text ?? "")
      const to = String(params.to ?? "en")
      const mock: Record<string, string> = {
        en: `[English] ${text} (Mock translation)`,
        ja: `[日本語] ${text} (モック翻訳)`,
        zh: `[中文] ${text}`,
        ko: `[한국어] ${text} (모의 번역)`,
      }
      return { success: true, content: `[MCP Translate → ${to}] ${mock[to] ?? text}` }
    },
  },
]

// ── 导出 ──

export function createMockMcpTools(): ToolDef[] {
  log.info("MCP Mock 工具已就绪:", MOCK_MCP_TOOLS.map(t => t.name).join(", "))
  return [...MOCK_MCP_TOOLS]
}

export function getMockMcpToolNames(): string[] {
  return MOCK_MCP_TOOLS.map(t => t.name)
}

// ── MCP 状态（Phase 4 升级为真实连接管理）──

let mcpConnected = false

export function isMcpConnected(): boolean {
  return mcpConnected
}

export function setMcpConnected(v: boolean): void {
  mcpConnected = v
}
