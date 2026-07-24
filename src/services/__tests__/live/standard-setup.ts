// ==========================================
// 标准场景 Setup — 场景间状态隔离
// ==========================================

import { destroyPool, initVariablePool } from "@/services/personality/variable-pool"
import { resetSession } from "@/services/engine/session"
import { clearMessages } from "@/services/session/store"
import { MemoryService } from "@/services/agent/memory"
import { getActiveCard, initRegistry } from "@/services/personality/registry"

let registryInitialized = false

export async function standardSetup(): Promise<void> {
  // 0. 确保 registry 已初始化（否则 getActiveCard 返回兜底 neutral）
  if (!registryInitialized) {
    await initRegistry()
    registryInitialized = true
  }

  // 1. 重置会话状态
  resetSession()

  // 2. 重置变量池
  const card = getActiveCard()
  if (card) {
    destroyPool()
    initVariablePool({
      cardId: card.id,
      variableDefs: card.sections.variableDefs,
    })
  }

  // 3. 清空记忆
  await MemoryService.init()
  MemoryService.clear()

  // 4. 清空聊天历史
  clearMessages()
}
