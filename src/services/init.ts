// ==========================================
// 统一初始化模块
// 所有应用启动初始化逻辑集中在此，按顺序执行
// ==========================================

import { MemoryService, stopMemoryConsolidationTimer } from "@/services/agent/memory"
import { initRegistry, initCards } from "@/services/personality"
import { registerDefaultTools, registerAssistantTools, unregisterAssistantTools } from "@/services/tool"
import { initDebug } from "@/services/debug"
import { initSessions, chatHistory, initWelcome } from "@/services/session"
import { getActiveCard } from "@/services/personality"
import { computeMcpEnabled, generalConfig, toolsConfig } from "@/services/config"
import { createLogger } from "@/services/logger"
import { harnessSlots } from "@/services/engine/pi"

const log = createLogger("Init")

/**
 * 统一初始化入口。
 * App.vue onMounted 中调用一次。
 *
 * 顺序:
 *   1. Memory 文件系统 (memory/ 目录就绪)
 *   2. 人格模块注册
 *   3. Presence 所需的基础工具
 *   4. 会话扫描恢复 (sessions → 列表 + 加载活跃会话消息) + Plan checkpoint 恢复
 *   5. 欢迎语 (仅当 chatHistory 确实为空)
 *   6. Debug 状态
 */
export async function initApp(): Promise<void> {
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
  await initCards()
  await initRegistry()
  log.info("3/7 人格模块就绪")

  // ── 4. 工具注册 ──
  await registerDefaultTools()
  log.info("4a/7 基础工具就绪")

  const { toolCount } = await import("@/services/tool/registry")
  log.info(`4/7 Presence 工具就绪 (${toolCount()} 个) | 助手配置:${generalConfig.assistantMode} MCP:${computeMcpEnabled()} Skill:${toolsConfig.skillEnabled}`)

  // ── 5. 会话初始化 ──
  // 崩溃恢复不再扫描旧队列事件：Harness 在打开会话时报告未完成操作（§8.7.3），
  // 由用户选择继续或丢弃；这里只恢复 Plan checkpoint。
  const sessions = await initSessions()
  log.info(`5/7 会话就绪: ${sessions.length} 个, 活跃: ${sessions[0]?.id ?? "无"}, 消息: ${chatHistory.length} 条`)
  const { recoverPlanCheckpoints } = await import("@/services/agent/runner")
  await recoverPlanCheckpoints()

  // ── 6. 欢迎语（一律走激活 Card 的问候语）──
  if (chatHistory.length === 0) {
    const { pickActiveGreeting } = await import("@/services/personality")
    const greeting = pickActiveGreeting()
    if (greeting) await initWelcome(greeting)
    log.info("6/7 欢迎语已写入")
  } else {
    log.info("6/7 跳过欢迎语（已有历史消息）")
  }

  // ── 7. Debug ──
  await initDebug()
  log.info("7/7 Debug 就绪")

  // LLM 记忆整理不属于 Presence 启动路径。清理热更新遗留定时器，后续只由
  // 已实现的记忆工作流在明确调度点启动，不能由应用启动隐式触发。
  stopMemoryConsolidationTimer()

  log.info("──── 初始化完成 ────")
}

/**
 * 对话前按本轮模式准备能力。调用方必须在 run 结束后才以 pet 调用本函数，不能
 * 在运行中清掉 router 仍可能使用的已冻结工具；root 在 run preflight 冻结 snapshot。
 */
export async function prepareConversationCapabilities(mode: "pet" | "assistant", owner = "runtime"): Promise<void> {
  await registerDefaultTools()
  if (mode === "assistant") {
    await registerAssistantTools()
    if (computeMcpEnabled()) {
      const { acquireMcpServer, getBuiltinServers, getMcpServers } = await import("@/services/tool/mcp")
      const servers = [...getBuiltinServers(), ...getMcpServers()]
      for (const server of servers) {
        if (!server.enabled) continue
        const acquired = await acquireMcpServer(server.name, owner)
        if (!acquired.success) log.warn(`MCP 获取失败: ${server.name} | ${acquired.error ?? "未知错误"}`)
      }
    }
  }
  if (toolsConfig.skillEnabled) {
    const { ensureSkillCatalog } = await import("@/services/skill")
    await ensureSkillCatalog()
  }
}

let pendingCapabilityMode: "pet" | "assistant" | null = null

/**
 * 设置保存时请求模式收敛。运行中的回合继续使用其冻结快照，最后一个回合 settled
 * 后由 runner 调用 applyPendingConversationCapabilities() 释放助手资源。
 */
export async function requestConversationCapabilityMode(mode: "pet" | "assistant"): Promise<boolean> {
  pendingCapabilityMode = mode
  if (harnessSlots.isAnyRunning()) {
    log.info("能力模式变更已延后到当前回合结束:", mode)
    return false
  }
  await applyPendingConversationCapabilities()
  return true
}

/** runner 在 harnessSlots.end() 后调用，避免模式切换破坏在飞工具调用。 */
export async function applyPendingConversationCapabilities(): Promise<void> {
  const mode = pendingCapabilityMode
  if (!mode || harnessSlots.isAnyRunning()) return
  pendingCapabilityMode = null
  if (mode === "pet") {
    // 仅在没有任何 run 时全局卸载助手本地工具；普通轻量 run 的 preflight 不做此事，
    // 避免并行助手 run 的 router 找不到已冻结的定义。
    unregisterAssistantTools()
    const { invalidateSkillCatalog } = await import("@/services/skill")
    invalidateSkillCatalog("mode-change")
    const { releaseMcpOwner } = await import("@/services/tool/mcp")
    await releaseMcpOwner("runtime")
    log.info("已切回轻量对话能力")
  }
  await prepareConversationCapabilities(mode)
}
