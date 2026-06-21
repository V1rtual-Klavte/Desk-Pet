// ==========================================
// 统一工具注册表 —— 按模式注册/查询/注销
// 所有工具（Local / MCP / Skill）在此统一管理
// ==========================================

import type { ToolDef, ToolDeclaration, ToolMode } from "./types"
import { toToolDeclaration } from "./types"
import { modeConfig } from "@/services/config"
import { createLogger } from "@/services/logger"

const log = createLogger("ToolReg")

// ── 核心存储 ──

/** 所有已注册工具 */
const tools = new Map<string, ToolDef>()

/** 注册工具 */
export function register(tool: ToolDef): void {
  if (tools.has(tool.id)) {
    log.warn("工具已存在，覆盖:", tool.id)
  }
  tools.set(tool.id, tool)
  log.debug("注册工具:", tool.id, "|", tool.mode)
}

/** 注销工具 */
export function unregister(id: string): boolean {
  const ok = tools.delete(id)
  if (ok) log.debug("注销工具:", id)
  return ok
}

/** 批量注册 */
export function registerAll(toolDefs: ToolDef[]): void {
  for (const t of toolDefs) register(t)
}

/** 获取单个工具 */
export function getTool(id: string): ToolDef | undefined {
  return tools.get(id)
}

/** 按名称查找（AI 调用的函数名） */
export function getToolByName(name: string): ToolDef | undefined {
  for (const t of tools.values()) {
    if (t.name === name) return t
  }
  return undefined
}

/** 获取当前模式下的所有工具 */
export function getToolsForMode(mode?: ToolMode): ToolDef[] {
  const m = mode ?? (modeConfig.assistant ? "assistant" : "pet")
  const result: ToolDef[] = []
  for (const t of tools.values()) {
    if (t.mode === m || t.mode === "pet") result.push(t)
  }
  return result
}

/** 获取当前模式下的工具声明（给 AI） */
export function getToolDeclarations(mode?: ToolMode): ToolDeclaration[] {
  return getToolsForMode(mode).map(toToolDeclaration)
}

/** 列出所有工具 */
export function listAll(): ToolDef[] {
  return [...tools.values()]
}

/** 清空所有工具 */
export function clearAll(): void {
  tools.clear()
  log.info("已清空所有工具")
}

/** 工具数量 */
export function toolCount(): number {
  return tools.size
}

// ── 初始化轻量模式工具 ──

let defaultToolsRegistered = false

/** 注册轻量模式基础工具（应用启动时调用一次） */
export async function registerDefaultTools(): Promise<void> {
  if (defaultToolsRegistered) return

  // 动态导入避免循环依赖
  const { registerFileTools } = await import("./local/file")
  const { registerBashTool } = await import("./local/bash")
  const { registerSystemTool } = await import("./local/system")
  const { registerHttpTool } = await import("./local/http")

  registerFileTools()
  registerBashTool()
  registerSystemTool()
  registerHttpTool()

  defaultToolsRegistered = true
  log.info("轻量模式工具已注册:", toolCount(), "个")
}

/** 注册助手模式工具（动态懒加载） */
export async function registerAssistantTools(): Promise<void> {
  const { registerFileWriteTool } = await import("./local-extra/file-write")
  const { registerBashFullTool } = await import("./local-extra/bash-full")
  const { registerAppOpenTool } = await import("./local-extra/app")
  const { registerClipboardTools } = await import("./local-extra/clipboard")
  const { registerAgentSpawnTool } = await import("./local-extra/agent-tool")

  const { registerFileDeleteTool } = await import("./local-extra/file-delete")

  registerFileWriteTool()
  registerBashFullTool()
  registerAppOpenTool()
  registerClipboardTools()
  registerAgentSpawnTool()
  registerFileDeleteTool()

  log.info("助手模式工具已注册, 总计:", toolCount(), "个")
}

/** 注销助手模式工具 */
export function unregisterAssistantTools(): void {
  for (const [id, tool] of tools) {
    if (tool.mode === "assistant") {
      tools.delete(id)
    }
  }
  log.info("助手模式工具已注销, 剩余:", toolCount(), "个")
}
