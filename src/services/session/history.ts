// ==========================================
// 会话历史读模型 —— sessions/ 仓库中的全部会话（含未打开标签的归档）
// 真相源是仓库文件；本模块只维护供面板消费的视图：
// 面板打开时全量重读，创建/删除/改名后由 manager 就地更新，避免每次操作都重扫仓库。
// ==========================================

import { ref } from "vue"
import type { PiSessionSummary } from "./repo"
import { listPiSessionMetadata, readPiSessionSummary } from "./repo"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("SessionHistory")

/** 仓库内的全部会话（创建时间倒序） */
export const sessionHistory = ref<PiSessionSummary[]>([])

export const sessionHistoryLoading = ref(false)
export const sessionHistoryError = ref(false)

/** 全量重读仓库；面板打开时调用。 */
export async function refreshSessionHistory(): Promise<void> {
  sessionHistoryLoading.value = true
  try {
    const metadata = await listPiSessionMetadata()
    const items: PiSessionSummary[] = []
    let failed = 0
    for (const item of metadata) {
      const summary = await readPiSessionSummary(item)
      if (summary) items.push(summary)
      else failed++
    }
    if (failed > 0) {
      // 单个会话读失败时列表不完整：复用同一个可见位，不把部分列表说成全部。
      sessionHistoryError.value = true
      log.error("部分会话读取失败，列表不完整:", failed)
    } else {
      sessionHistoryError.value = false
    }
    sessionHistory.value = items
  } catch (error) {
    // 读取失败不能与「确实没有会话」同形：否则用户会以为历史被清空了。
    log.warn("加载历史会话失败:", formatError(error))
    sessionHistory.value = []
    sessionHistoryError.value = true
  } finally {
    sessionHistoryLoading.value = false
  }
}

/** 新会话落盘后插入表头（与仓库的创建时间倒序一致）。 */
export function prependSessionHistory(summary: PiSessionSummary): void {
  sessionHistory.value = [summary, ...sessionHistory.value.filter(item => item.id !== summary.id)]
}

/** 会话文件删除成功后移出列表。 */
export function removeSessionHistory(sessionId: string): void {
  sessionHistory.value = sessionHistory.value.filter(item => item.id !== sessionId)
}

/** 展示名变更后就地更新；列表未加载时无事可做，下次打开面板会整体重读。 */
export function renameSessionHistory(sessionId: string, name: string): void {
  const item = sessionHistory.value.find(entry => entry.id === sessionId)
  if (!item) return
  item.name = name
}
