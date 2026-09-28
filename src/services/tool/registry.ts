// ==========================================
// 统一工具注册表 —— 注册/查询/注销
// 所有工具（Local / MCP / Skill）在此统一管理
// ==========================================

import type { ToolDef } from "./types"
import { getToolHandler, validateToolPolicy } from "./policy"
import { createLogger } from "@/services/logger"

const log = createLogger("ToolReg")

// ── 核心存储 ──

/** 所有已注册工具 */
const tools = new Map<string, ToolDef>()

/** 注册工具。缺少或不一致的策略是注册错误，不做缺省猜测；入库的是校验后的冻结定义。 */
export function register(tool: ToolDef): void {
  if (!getToolHandler(tool)) {
    throw new Error(`工具未经 defineTool 构造（缺少执行体），拒绝注册: ${tool.id || "<未知工具>"}`)
  }
  validateToolPolicy(tool.policy, tool.id)
  const conflicting = getToolByName(tool.name)
  if (conflicting && conflicting.id !== tool.id) {
    throw new Error(`工具名称冲突: ${tool.name} (${conflicting.id} / ${tool.id})`)
  }
  if (tools.has(tool.id)) {
    // 同 id 重复注册是覆盖语义，不是错误：Live Test 用它把探针换成具体实现。
    log.warn("工具已存在，覆盖:", tool.id)
  }
  // 直接入库、不克隆：defineTool 的产物已冻结，克隆还会丢 WeakMap 里的执行体身份。
  tools.set(tool.id, tool)
  log.debug("注册工具:", tool.id)
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

/**
 * 工具过程文案的类别解析入口：唯一声明点是 ToolDef.actionCategory，
 * UI（ChatPanel 的工具状态提示）与阶段文案（getStagePrompt）经它对齐。
 * 未注册的工具（已释放的 MCP、Skill 或不存在的名字）按 `_default` 处理。
 */
export function actionCategoryOf(toolName: string): string {
  return getToolByName(toolName)?.actionCategory ?? "_default"
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

// ── 初始化基础工具 ──

let defaultToolsRegistered = false

/**
 * 注册全部内置基础工具（应用启动时调用一次）。内置工具恒暴露、不做开关，
 * 边界一律交给权限裁决，因此这里不按能力分组，也不再提供局部注销入口。
 */
export async function registerDefaultTools(): Promise<void> {
  if (defaultToolsRegistered) return

  // 动态导入避免循环依赖
  const { registerPiBaseTools } = await import("./local/pi-tools")
  const { registerSystemTool } = await import("./local/system")
  const { registerWindowInfoTool } = await import("./local/window")
  const { registerAppOpenTool } = await import("./local-extra/app")
  const { registerClipboardTools } = await import("./local-extra/clipboard")
  const { registerAgentSpawnTool } = await import("./local-extra/agent-tool")

  await registerPiBaseTools()
  registerSystemTool()
  registerWindowInfoTool()
  registerAppOpenTool()
  registerClipboardTools()
  registerAgentSpawnTool()

  defaultToolsRegistered = true
  log.info("基础工具已注册:", toolCount(), "个")
}
