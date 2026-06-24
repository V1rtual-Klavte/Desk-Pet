// ==========================================
// 统一初始化模块
// 所有应用启动初始化逻辑集中在此，按顺序执行
// ==========================================

import { MemoryService, startMemoryConsolidationTimer } from "@/services/agent/memory"
import { initRegistry } from "@/services/personality"
import { registerDefaultTools, registerAll } from "@/services/tool"
import { initDebug } from "@/services/debug"
import { initSessions, chatHistory, initWelcome } from "@/services/session"
import { getActiveCard } from "@/services/personality"
import { createLogger } from "@/services/logger"

const log = createLogger("Init")

/**
 * 统一初始化入口。
 * App.vue onMounted 中调用一次。
 *
 * 顺序:
 *   1. Memory 文件系统 (memory/ + sessions/ 目录就绪)
 *   2. 人格模块注册
 *   3. 工具注册 (默认 + Skill + MCP Mock)
 *   4. 会话扫描恢复 (sessions/*.md → 列表 + 加载活跃会话消息)
 *   5. 欢迎语 (仅当 chatHistory 确实为空)
 *   6. Debug 状态
 */
export async function initApp(welcomeText: string): Promise<void> {
	log.info("──── 初始化开始 ────")

	// ── 1. Memory 文件系统 ──
	await MemoryService.init()
	log.info("1/6 Memory 文件系统就绪")

	// ── 2. 人格模块 ──
	initRegistry()
	log.info("2/6 人格模块就绪")

	// ── 3. 工具注册 ──
	await registerDefaultTools()
	const { getSkillTools } = await import("@/services/tool/skill/loader")
	const { initSkillRegistry } = await import("@/services/tool/skill/registry")
	const { createMockMcpTools } = await import("@/services/tool/mcp/manager")
	initSkillRegistry()
	registerAll(getSkillTools())
	registerAll(createMockMcpTools())
	const { toolCount } = await import("@/services/tool/registry")
	log.info(`3/6 工具就绪 (${toolCount()} 个)`)

	// ── 4. 会话初始化 ──
	//    initSessions() 扫描 sessions/ 目录 → 重建会话列表
	//    → 加载活跃会话消息到 chatHistory → 写入 localStorage 缓存
	const sessions = await initSessions()
	log.info(`4/6 会话就绪: ${sessions.length} 个, 活跃: ${sessions[0]?.id ?? "无"}, 消息: ${chatHistory.length} 条`)

	// ── 5. 欢迎语 ──
	//    仅当 chatHistory 为空（没有从 sessions/ 恢复任何消息）时才写欢迎语
	const card = getActiveCard()
	if (chatHistory.length === 0) {
		if (welcomeText) {
			initWelcome(welcomeText)
		} else if (card?.firstMessage) {
			initWelcome(card.firstMessage)
		}
		log.info("5/6 欢迎语已写入")
	} else {
		log.info("5/6 跳过欢迎语（已有历史消息）")
	}

	// ── 6. Debug ──
	await initDebug()
	log.info("6/6 Debug 就绪")

	// ── 启动后台任务 ──
	startMemoryConsolidationTimer()

	log.info("──── 初始化完成 ────")
}
