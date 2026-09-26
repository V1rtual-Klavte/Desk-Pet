// ==========================================
// 统一初始化模块
// 所有应用启动初始化逻辑集中在此，按顺序执行
// ==========================================

import { MemoryService } from "@/services/agent/memory"
import { initRegistry, initCards } from "@/services/personality"
import { registerDefaultTools } from "@/services/tool"
import { initDebug } from "@/services/debug"
import { initSessions, chatHistory, initWelcome, getActiveSessionId } from "@/services/session"
import { getActiveCard } from "@/services/personality"
import { computeMcpEnabled, enabledMcpServerNames } from "@/services/config"
import { createLogger } from "@/services/logger"

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
  log.info(`4/7 Presence 工具就绪 (${toolCount()} 个) | MCP:${computeMcpEnabled()}`)

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
    if (greeting) await initWelcome(greeting, getActiveSessionId())
    log.info("6/7 欢迎语已写入")
  } else {
    log.info("6/7 跳过欢迎语（已有历史消息）")
  }

  // ── 7. Debug ──
  await initDebug()
  log.info("7/7 Debug 就绪")

  // LLM 记忆整理不属于 Presence 启动路径；当前没有自动整理定时器，长期记忆闭环在 P6。

  log.info("──── 初始化完成 ────")
}

/** 一次能力准备的结果：启用但本次没能借用成功的 MCP 服务器名。 */
export interface CapabilityPrepResult {
  unavailableMcp: string[]
}

/**
 * 对话前准备本轮能力：借用启用的 MCP 服务器、预热 Skill 目录。调用方必须在
 * run 结束后才调用本函数，不能在运行中清掉 router 仍可能使用的已冻结工具；
 * root 在 run preflight 冻结 snapshot。
 * 借用失败的服务器名交回调用方，由它决定是否把「本次能力不全」变成可见结论。
 */
export async function prepareConversationCapabilities(owner: string): Promise<CapabilityPrepResult> {
  await registerDefaultTools()
  const unavailableMcp: string[] = []
  // 借用面与「MCP 是否生效」同源（config 的 enabledMcpServerNames）：总闸已删，控制面在
  // 每服务器的 enabled，全部关掉即无人可借。owner 必填：调用方一律给本轮的 requestId 或
  // resumeOwner(sessionId)，默认值会让「谁借的」失去唯一来源，也让释放失去配对。
  const { acquireMcpServer } = await import("@/services/tool/mcp")
  for (const name of enabledMcpServerNames()) {
    const acquired = await acquireMcpServer(name, owner)
    if (!acquired.success) {
      unavailableMcp.push(name)
      log.warn(`MCP 获取失败: ${name} | ${acquired.error ?? "未知错误"}`)
    }
  }
  // 每回合的 Skill 目录指纹核对挂在这里：主回合（runtime.ts 的 runPiAgentTurn）、续跑与 Plan 恢复
  // 都经本函数进入，稳态恰好 1 次 Rust IPC（指纹没变就复用 store 的清单）。磁盘一变即重载，
  // 所以「实时」由每回合核对保证 —— 没有 TTL、不需要重启；决策 8 删总开关后本入口不再把关。
  const { syncSkillCatalog } = await import("@/services/skill")
  await syncSkillCatalog()
  return { unavailableMcp }
}

/**
 * run 级能力准备：借用 MCP / 预热 Skill 目录，并在借用失败时把不可用的服务器名单交回调用方。
 * `assertCurrent` 在准备前后各调一次 —— 准备期间回合可能已被取消。
 */
export async function prepareRunCapabilities(
  owner: string, assertCurrent?: () => void,
): Promise<CapabilityPrepResult> {
  assertCurrent?.()
  const result = await prepareConversationCapabilities(owner)
  assertCurrent?.()
  return result
}
