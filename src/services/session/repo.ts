// ==========================================
// Pi 会话仓库访问层（H-2）
// 懒加载 JsonlSessionRepo 单例，统一管理打开句柄、元数据读取与会话增删。
// 会话正文归属 `<数据根>/sessions/` 下的 JSONL；index.json 只承载可丢弃 UI 状态。
// ==========================================

import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core"
import type { Entry, EntryQuery, JsonValue, JsonlSessionMetadata, Session } from "@earendil-works/pi-agent-core"
import { createPiSessionRepo } from "@/services/engine/pi"
import type { PiSessionRepo } from "@/services/engine/pi"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("PiSession")

/** 单 lane 分支名（方案 §8.1）；宿主与运行内核必须使用同一个分支。 */
export const PI_LANE = "main"

/** 会话列表项：仓库元数据 + 展示名 + 消息数，供标签栏与历史面板消费。 */
export interface PiSessionSummary {
  id: string
  name: string
  createdAt: number
  messageCount: number
  modifiedAt: number
  path: string
}

let repoPromise: Promise<PiSessionRepo> | null = null

/** 懒加载会话仓库；应用生命周期内单例，避免多份仓库各自打开同一文件。 */
export function getPiSessionRepo(): Promise<PiSessionRepo> {
  repoPromise ??= createPiSessionRepo().catch((error) => {
    repoPromise = null
    throw error
  })
  return repoPromise
}

/** 测试隔离：关闭全部句柄并丢弃仓库单例（不删除任何数据）。 */
export async function resetPiSessionLayerForTest(): Promise<void> {
  for (const sessionId of [...openSessions.keys()]) {
    await releasePiSession(sessionId)
  }
  repoPromise = null
}

/** 测试隔离：清空数据根下的全部 pi 会话文件（先释放句柄再删除）。 */
export async function deleteAllPiSessionsForTest(): Promise<number> {
  await resetPiSessionLayerForTest()
  const repo = await getPiSessionRepo()
  const metadata = await repo.list(undefined, BACKGROUND_CONTEXT)
  for (const item of metadata) await repo.delete(item, BACKGROUND_CONTEXT)
  return metadata.length
}

/**
 * 已打开的会话句柄缓存。
 * JSONL 仓库要求同一会话只能被打开一次（再次 open 会抛错），所以所有 open 都集中在这里。
 * 运行内核注入 `createAgentHarness({ session })` 时也必须经 acquirePiSession() 取句柄，
 * 不要自行 createPiSessionRepo() 打开同一会话。
 */
const openSessions = new Map<string, Promise<Session<JsonlSessionMetadata>>>()

/** 仓库内的全部会话元数据（创建时间倒序）。 */
export async function listPiSessionMetadata(): Promise<JsonlSessionMetadata[]> {
  const repo = await getPiSessionRepo()
  return repo.list(undefined, BACKGROUND_CONTEXT)
}

/** 打开（或复用）会话句柄；句柄保持打开直到 releasePiSession()。 */
export async function acquirePiSession(sessionId: string): Promise<Session<JsonlSessionMetadata>> {
  const cached = openSessions.get(sessionId)
  if (cached) return cached
  const opening = (async () => {
    const repo = await getPiSessionRepo()
    const metadata = (await repo.list(undefined, BACKGROUND_CONTEXT)).find(item => item.id === sessionId)
    if (!metadata) throw new Error(`pi 会话不存在: ${sessionId}`)
    const session = await repo.open(metadata, BACKGROUND_CONTEXT)
    log.info("已打开会话:", sessionId)
    return session
  })()
  openSessions.set(sessionId, opening)
  try {
    return await opening
  } catch (error) {
    openSessions.delete(sessionId)
    throw error
  }
}

/** 关闭并移出句柄缓存；调用方须先确认该会话没有运行中的回合。 */
export async function releasePiSession(sessionId: string): Promise<void> {
  const handle = openSessions.get(sessionId)
  if (!handle) return
  openSessions.delete(sessionId)
  try {
    const session = await handle
    await session.close(BACKGROUND_CONTEXT)
    log.info("已关闭会话:", sessionId)
  } catch (error) {
    log.warn("关闭会话失败:", sessionId, formatError(error))
  }
}

async function readSummary(session: Session<JsonlSessionMetadata>): Promise<PiSessionSummary> {
  const [name, stats] = await Promise.all([
    session.getName(BACKGROUND_CONTEXT),
    session.getStats(BACKGROUND_CONTEXT),
  ])
  return {
    id: session.metadata.id,
    name: name ?? "",
    createdAt: session.metadata.createdAt,
    messageCount: stats.messageCount,
    modifiedAt: session.metadata.modifiedAt,
    path: session.metadata.path,
  }
}

/**
 * 读取一个会话的展示元数据。
 * 已打开的句柄直接复用；未打开的短暂打开后立即关闭，不驻留句柄。
 */
export async function readPiSessionSummary(metadata: JsonlSessionMetadata): Promise<PiSessionSummary | null> {
  const alreadyOpen = openSessions.has(metadata.id)
  try {
    const session = await acquirePiSession(metadata.id)
    try {
      return await readSummary(session)
    } finally {
      if (!alreadyOpen) await releasePiSession(metadata.id)
    }
  } catch (error) {
    log.warn("读取会话元数据失败:", metadata.id, formatError(error))
    return null
  }
}

/** 新建会话并写入展示名；句柄保留在缓存中，等待切换为活跃会话或运行内核使用。 */
export async function createPiSession(name: string): Promise<PiSessionSummary> {
  const repo = await getPiSessionRepo()
  const session = await repo.create({}, BACKGROUND_CONTEXT)
  await session.setName(name, BACKGROUND_CONTEXT)
  openSessions.set(session.metadata.id, Promise.resolve(session))
  const summary = await readSummary(session)
  log.info("已创建会话:", summary.id, name)
  return summary
}

/** 重命名会话（展示名持久化在会话文件里）；失败只记日志，不阻断发送流程。 */
export async function persistPiSessionName(sessionId: string, name: string): Promise<boolean> {
  try {
    const session = await acquirePiSession(sessionId)
    await session.setName(name, BACKGROUND_CONTEXT)
    return true
  } catch (error) {
    log.warn("会话重命名落盘失败:", sessionId, formatError(error))
    return false
  }
}

/** 删除会话文件；先释放句柄（仓库要求删除时会话未打开）。 */
export async function deletePiSession(sessionId: string): Promise<boolean> {
  const repo = await getPiSessionRepo()
  const metadata = (await repo.list(undefined, BACKGROUND_CONTEXT)).find(item => item.id === sessionId)
  if (!metadata) {
    log.warn("待删除会话不存在:", sessionId)
    return false
  }
  await releasePiSession(sessionId)
  await repo.delete(metadata, BACKGROUND_CONTEXT)
  log.info("已删除会话:", sessionId)
  return true
}

/** 读取会话全部 entry（按 seq 升序），供展示读模型映射历史消息。 */
export async function readPiSessionEntries(sessionId: string): Promise<Entry[]> {
  const session = await acquirePiSession(sessionId)
  return session.findEntries({ order: "asc" }, BACKGROUND_CONTEXT)
}

/**
 * 按查询读取会话 entry 后释放句柄（调用前未打开时不驻留）。
 * 供启动期批量扫描使用（Plan checkpoint 恢复），避免把所有历史会话都留在句柄缓存里；
 * 扫描方按 `customType` 收窄读取集合，不再全量解析每个会话。
 */
export async function readPiSessionEntriesOnce(sessionId: string, query?: EntryQuery): Promise<Entry[]> {
  const alreadyOpen = openSessions.has(sessionId)
  const session = await acquirePiSession(sessionId)
  try {
    return await session.findEntries(query ?? { order: "asc" }, BACKGROUND_CONTEXT)
  } finally {
    if (!alreadyOpen) await releasePiSession(sessionId)
  }
}

/** 追加 deskpet 自定义 entry（宿主生成、非模型消息）；lane 分支不存在时按需创建。返回条目 id。 */
export async function appendPiSessionCustomEntry(sessionId: string, customType: string, data?: JsonValue): Promise<string> {
  const session = await acquirePiSession(sessionId)
  const branch = await session.branch(PI_LANE, BACKGROUND_CONTEXT)
    ?? await session.createBranch(PI_LANE, null, BACKGROUND_CONTEXT)
  return await branch.appendCustomEntry(customType, data, BACKGROUND_CONTEXT)
}
