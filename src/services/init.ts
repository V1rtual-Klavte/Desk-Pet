// ==========================================
// 统一初始化模块
// 所有应用启动初始化逻辑集中在此，按顺序执行
// ==========================================

import { MemoryService, startMemoryConsolidationTimer } from "@/services/agent/memory"
import { initRegistry } from "@/services/personality"
import { registerDefaultTools, registerAll, registerAssistantTools } from "@/services/tool"
import { initDebug } from "@/services/debug"
import { initSessions, chatHistory, initWelcome } from "@/services/session"
import { getActiveCard } from "@/services/personality"
import { modeConfig, toolsConfig } from "@/services/config"
import { createLogger } from "@/services/logger"

const log = createLogger("Init")

/**
 * 统一初始化入口。
 * App.vue onMounted 中调用一次。
 *
 * 顺序:
 *   1. Memory 文件系统 (memory/ + sessions/ 目录就绪)
 *   2. 人格模块注册
 *   3. 工具注册 (默认 + 条件: 助手工具/MCP/Skill)
 *   4. 会话扫描恢复 (sessions/*.md → 列表 + 加载活跃会话消息)
 *   5. 欢迎语 (仅当 chatHistory 确实为空)
 *   6. Debug 状态
 */
export async function initApp(welcomeText: string): Promise<void> {
  log.info("──── 初始化开始 ────")

  // ── 1. Memory 文件系统 ──
  await MemoryService.init()
  log.info("1/7 Memory 就绪")

  // ── 2. Profile 系统 ──
  const { initProfiles, getActiveProfile } = await import("@/services/profile")
  await initProfiles()
  const p = getActiveProfile()
  log.info(`2/7 Profile 就绪: "${p?.meta.name}" (${p?.character.name})`)

  // ── 3. 人格模块 ──
  initRegistry()
  log.info("3/7 人格模块就绪")

  // ── 4. 工具注册 ──
  await registerDefaultTools()
  log.info("4a/7 基础工具就绪")

  if (modeConfig.assistant) {
    await registerAssistantTools()
    log.info("4b/7 助手工具就绪")
  }

  if (toolsConfig.mcpEnabled) {
    const { connectAllMcpServers } = await import("@/services/tool/mcp/manager")
    const connected = await connectAllMcpServers()
    log.info(`4c/7 MCP 就绪 (${connected} 个服务器连接)`)
  }

  if (toolsConfig.skillEnabled) {
    const { getSkillTools } = await import("@/services/tool/skill/loader")
    const { initSkillRegistry } = await import("@/services/tool/skill/registry")
    initSkillRegistry()
    registerAll(getSkillTools())
    log.info("4d/7 Skill 工具就绪")
  }

  const { toolCount } = await import("@/services/tool/registry")
  log.info(`4/7 工具就绪 (${toolCount()} 个) | 助手:${modeConfig.assistant} MCP:${toolsConfig.mcpEnabled} Skill:${toolsConfig.skillEnabled}`)

  // ── 5. 会话初始化 ──
  const sessions = await initSessions()
  log.info(`5/7 会话就绪: ${sessions.length} 个, 活跃: ${sessions[0]?.id ?? "无"}, 消息: ${chatHistory.length} 条`)

  // ── 6. 欢迎语 ──
  const card = getActiveCard()
  if (chatHistory.length === 0) {
    if (welcomeText) {
      initWelcome(welcomeText)
    } else if (card?.firstMessage) {
      initWelcome(card.firstMessage)
    }
    log.info("6/7 欢迎语已写入")
  } else {
    log.info("6/7 跳过欢迎语（已有历史消息）")
  }

  // ── 7. Debug ──
  await initDebug()
  log.info("7/7 Debug 就绪")

  // ── 启动后台任务 ──
  startMemoryConsolidationTimer()

  log.info("──── 初始化完成 ────")
}
