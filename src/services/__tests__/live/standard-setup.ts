// ==========================================
// 标准场景 Setup — 场景间状态隔离
// ==========================================

import { destroyPool, initVariablePool } from "@/services/personality/variable-pool"
import { resetSession } from "@/services/engine/session"
import { clearMessages } from "@/services/session/store"
import { activeSessionId, sessions, unansweredCount } from "@/services/session/store"
import { resetSessionPersistenceForTest } from "@/services/session/persistence"
import { MemoryService } from "@/services/agent/memory"
import { flushMemory } from "@/services/agent/memory/memory-entries"
import { resetSessionRuntimeForTest } from "@/services/agent/memory/session-files"
import { getActiveCard, initRegistry } from "@/services/personality/registry"
import { initCards } from "@/services/personality/loader"
import { registerDefaultTools } from "@/services/tool/registry"
import { resetCooldown, setAIGenerating } from "@/services/cooldown"
import { resetPreprocessorForTest } from "@/services/engine/preprocessor"
import { resetPiRuntimeProviderForTest } from "@/services/engine/pi"
import { resetRuntimeQueueForTest } from "@/services/agent/runner"
import { resetConfirmChannel } from "./confirm-channel"
import type { ConfirmPolicy } from "./types"

let bootstrapped = false

async function bootstrapOnce(): Promise<void> {
  if (bootstrapped) return
  await initCards()
  await initRegistry()
  await registerDefaultTools()
  bootstrapped = true
}

/**
 * 场景隔离入口。
 *
 * `confirmPolicy` 由场景声明（`meta.confirmPolicy`），在隔离点一起重置：
 * 确认通道是典型跨场景状态，一个场景留下的 pending 必须在这里被收尾，
 * 不能等下一个场景的请求把它覆盖掉。
 */
export async function standardSetup(confirmPolicy: ConfirmPolicy = "deny"): Promise<void> {
  await bootstrapOnce()
  resetConfirmChannel(confirmPolicy)

  // 上一场景的异步 session 写入必须先完成，之后才能清空模块状态。
  await MemoryService.init()
  await resetSessionRuntimeForTest()
  for (const session of await MemoryService.listSessionFiles()) {
    await MemoryService.deleteSessionFile(session.filename)
  }
  await resetSessionRuntimeForTest()

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
  MemoryService.clear()
  await flushMemory()

  // 4. 清空聊天历史
  clearMessages()
  sessions.splice(0, sessions.length)
  activeSessionId.value = ""
  unansweredCount.value = 0
  resetCooldown()
  setAIGenerating(false)
  resetPreprocessorForTest()
  resetPiRuntimeProviderForTest()
  await resetRuntimeQueueForTest()
  await resetSessionPersistenceForTest()
}
