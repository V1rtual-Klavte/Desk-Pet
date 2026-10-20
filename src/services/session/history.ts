// ==========================================
// 会话历史读模型 —— sessions/ 仓库中的全部会话（含未打开标签的归档）
// 真相源是仓库文件；本模块只维护供面板消费的视图：
// 面板打开时全量重读，创建/删除/改名后由 manager 就地更新，避免每次操作都重扫仓库。
// ==========================================

import { ref } from "vue"
import type { PiSessionSummary } from "./repo"
import { listPiSessionMetadata, readPiSessionSummary } from "./repo"
import { compareSessionActivity } from "./activity"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("SessionHistory")

/** 仓库内的全部会话（用户活动时间倒序；没有用户消息的按创建时间回退，见 activity.ts） */
export const sessionHistory = ref<PiSessionSummary[]>([])

export const sessionHistoryLoading = ref(false)
export const sessionHistoryError = ref(false)

/**
 * 启动期已经读过的**派生摘要**缓存：文件 mtime 未变就不再打开/关闭/折叠整个 JSONL。
 * 只存 JSONL 头里没有的字段（name/messageCount/activityAt）；id/createdAt/path 每次
 * 从 `listPiSessionMetadata()` 现拼，不重复存，也不缓存任何正文。
 */
interface CachedSummary {
  modifiedAt: number
  name: string
  messageCount: number
  activityAt: number | null
}
const summaryCache = new Map<string, CachedSummary>()

function cacheSummary(summary: PiSessionSummary): void {
  summaryCache.set(summary.id, {
    modifiedAt: summary.modifiedAt,
    name: summary.name,
    messageCount: summary.messageCount,
    activityAt: summary.activityAt,
  })
}

/** 启动期读到一个摘要后登记，供历史面板首次打开复用。 */
export function rememberSessionSummary(summary: PiSessionSummary): void {
  cacheSummary(summary)
}

/** 有界并发：历史面板可能有很多会话，串行打开/折叠会让首帧明显变慢。 */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let index = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const current = index++
      if (current >= items.length) return
      results[current] = await fn(items[current]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** 全量重读仓库；面板打开时调用。 */
export async function refreshSessionHistory(): Promise<void> {
  sessionHistoryLoading.value = true
  try {
    const metadata = await listPiSessionMetadata()
    // 外部删掉/归档掉的会话不留在进程里：缓存只跟随当前仓库清单。
    const liveIds = new Set(metadata.map(item => item.id))
    for (const id of summaryCache.keys()) if (!liveIds.has(id)) summaryCache.delete(id)
    let failed = 0
    const items = (await mapLimit(metadata, 3, async item => {
      const cached = summaryCache.get(item.id)
      if (cached && cached.modifiedAt === item.modifiedAt) {
        return {
          id: item.id, name: cached.name, createdAt: item.createdAt,
          messageCount: cached.messageCount, activityAt: cached.activityAt,
          modifiedAt: item.modifiedAt, path: item.path,
        } satisfies PiSessionSummary
      }
      const summary = await readPiSessionSummary(item)
      if (!summary) return null
      cacheSummary(summary)
      return summary
    })).filter((summary): summary is PiSessionSummary => {
      if (summary) return true
      failed++
      return false
    })
    if (failed > 0) {
      // 单个会话读失败时列表不完整：复用同一个可见位，不把部分列表说成全部。
      sessionHistoryError.value = true
      log.error("部分会话读取失败，列表不完整:", failed)
    } else {
      sessionHistoryError.value = false
    }
    // 列表口径 = 用户活动时间倒序（缺省回退 createdAt）；不沿用仓库列举的 createdAt 顺序。
    items.sort(compareSessionActivity)
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

/** 新会话落盘后插入表头（还没有用户消息，活动时间回退 createdAt = 最新，排在最前）。 */
export function prependSessionHistory(summary: PiSessionSummary): void {
  cacheSummary(summary)
  sessionHistory.value = [summary, ...sessionHistory.value.filter(item => item.id !== summary.id)]
}

/** 会话文件删除成功后移出列表。 */
export function removeSessionHistory(sessionId: string): void {
  summaryCache.delete(sessionId)
  sessionHistory.value = sessionHistory.value.filter(item => item.id !== sessionId)
}

/** 展示名变更后就地更新；列表未加载时无事可做，下次打开面板会整体重读。 */
export function renameSessionHistory(sessionId: string, name: string): void {
  const item = sessionHistory.value.find(entry => entry.id === sessionId)
  if (!item) return
  item.name = name
  const cached = summaryCache.get(sessionId)
  if (cached) cached.name = name
}
