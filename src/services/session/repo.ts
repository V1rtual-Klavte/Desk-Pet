// ==========================================
// Pi 会话仓库访问层（H-2）
// 懒加载 JsonlSessionRepo 单例，统一管理打开句柄、元数据读取与会话增删。
// 会话正文归属 `<数据根>/sessions/` 下的 JSONL；index.json 只承载可丢弃 UI 状态。
// ==========================================

import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core"
import type { Entry, EntryQuery, JsonValue, JsonlSessionMetadata, Session } from "@earendil-works/pi-agent-core"
import { createPiSessionRepo, flushSessionFrameWrites } from "@/services/engine/harness"
import type { PiSessionRepo } from "@/services/engine/harness"
import { createLogger } from "@/services/logger"
import { formatError, reportError } from "@/services/error"

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
  // 句柄循环可能一次都没走（本 trial 没打开过仓库）：仍要冲一次 —— 帧缓冲挂在模块级
  // 注册表上，不跨 trial 残留（测试隔离；T-6 的测试侧）。
  await flushSessionFrameWrites(BACKGROUND_CONTEXT)
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

/** 已留过证据的跨根会话 id：同一批跨根项只报一次，不随每次列举刷日志。 */
const reportedForeignRootIds = new Set<string>()

/**
 * 仓库内的全部会话元数据（创建时间倒序）。
 *
 * 归属按**文件头 `cwd`** 判定，不是按 `--<cwd>--` 目录名猜：数据根变更或目录编码碰撞
 * 都会让仓库里出现不属于当前数据根的会话。这类项标注并留一次日志，不清除、不改
 * `index.json` —— 「`index.json` 里有 id、列表里静默消失」正是要修掉的现象。
 */
export async function listPiSessionMetadata(): Promise<JsonlSessionMetadata[]> {
  const repo = await getPiSessionRepo()
  const metadata = await repo.list(undefined, BACKGROUND_CONTEXT)
  const foreign = metadata.filter(item => item.cwd !== repo.cwd)
  if (foreign.length > 0) {
    const unseen = foreign.filter(item => !reportedForeignRootIds.has(item.id))
    if (unseen.length > 0) {
      unseen.forEach(item => reportedForeignRootIds.add(item.id))
      log.warn("列出不属于当前数据根的会话（数据根变更或目录编码碰撞）:", {
        cwds: [...new Set(foreign.map(item => item.cwd))], ids: unseen.map(item => item.id),
      })
    }
  }
  return metadata
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

/**
 * 关闭并移出句柄缓存；调用方须先确认该会话没有运行中的回合。
 *
 * T-6（关闭 / 退出前缓冲被 flush）在本仓的挂点就在这里：上游
 * `HarnessSlot.close → harness.close → session.close → storage.close` 全链路一次 `FileSystem`
 * 调用都没有（执行方案 §0.3），句柄一关就没有别的触发点，只能在此显式冲掉帧缓冲。
 * 直接调用方（`repo.ts` 内部、`harness-slot.ts`）无需各自改动即获得 flush。
 *
 * 顺序必须是「先 close 再 flush」：`session.close()` 会等 mutation line 与 `commitQueue`
 * 排干，即所有帧写入都已进过装饰器；反过来会与在飞提交赛跑，漏掉最后一帧。
 * flush 自身不抛（`session-frame-buffer.ts`），放进 `finally` 是为了 close 抛错时也冲。
 *
 * 边界（不扩大实施范围）：
 * - 「退出前」在本任务的口径是「会话句柄关闭 / 槽关闭前」；**应用级强制退出不覆盖** ——
 *   托盘 `app.exit(0)` 不经前端、`CloseRequested` 只隐藏到托盘，本仓没有可挂的应用级
 *   teardown。因此**不**补窗口卸载钩子（在卸载前事件上做异步 IPC 与 `app.exit` 有竞态；
 *   该边界已登记在《未完成工作与已知缺口》「不修/暂不修边界」的「退出钩子」条目）。
 * - 可接受损失：进程被强杀，或托盘 `app.exit` 且仍在流式中时，缓冲里最多 16 KiB 的
 *   **进度快照**丢失；正文 entry 走非帧路径（T-3），已在盘上。
 *
 * T5.04（折叠的回收主路径）同样挂在这里：`try/catch/finally` **整体之后**调一次
 * `foldSession`。顺序不可反 —— 折叠的读/写/rename 会命中 W1 装饰器的「同路径先 flush」规则，
 * 所以必须**先 flush 填满文件、再折叠回收**；把折叠塞进 `try` 内（close 之后、flush 之前）
 * 就是与在飞帧赛跑，缓冲里的帧会被追加到折叠结果之后。
 * 为什么不用上游 `onClose`：它由上游在 `.finally()` 里调用且不 await，挂上去必然是浮动
 * Promise。这里 `await` 是必须的（不能 fire-and-forget，否则进程退出时折叠还在飞）；
 * 用户可感知成本只有一次 stat（文件未超闸门时）。
 * 折叠失败只留痕、不影响关闭语义；`deletePiSession`、`readPiSessionSummary`、
 * `readPiSessionEntriesOnce` 等调用方也走这条释放路径并同样折叠 —— 这是**已接受**的行为
 * （> `minFileBytes` 的会话多一次 stat，超过回收闸门的会读全文并可能重写）。若实测在历史
 * 面板刷新时有可见开销，上调 `FOLD_POLICY` 常量（单点可调），不要按调用方加旁路分支。
 */
export async function releasePiSession(sessionId: string): Promise<void> {
  const handle = openSessions.get(sessionId)
  if (!handle) return
  openSessions.delete(sessionId)
  // 折叠要用 metadata 定位文件，而它只能从 `await handle` 得到的句柄上取（不另存一份，
  // 不给 openSessions 加第二种值形态）；因此先在这里声明、在 try 内赋值。
  let metadata: JsonlSessionMetadata | undefined
  try {
    const session = await handle
    metadata = session.metadata
    await session.close(BACKGROUND_CONTEXT)
    log.info("已关闭会话:", sessionId)
  } catch (error) {
    log.error("关闭会话失败:", sessionId, formatError(error))
  } finally {
    // 句柄一关就再没有别的触发点：缓冲里剩下的帧只能在这里落地（T-6）。
    await flushSessionFrameWrites(BACKGROUND_CONTEXT)
  }
  // metadata 缺 = 句柄从未打开成功（open 的失败已在上面的 catch 里留痕），没有可折叠的文件。
  if (!metadata) return
  // 折叠窗口：句柄已关闭、上面的 flush 也已收尾，此刻该文件没有写入者。失败只留痕，
  // 绝不让释放抛出（getPiSessionRepo 的 rejection 也一起吃下，释放语义不依赖折叠）。
  try {
    const repo = await getPiSessionRepo()
    await repo.foldSession(metadata, BACKGROUND_CONTEXT)
  } catch (error) {
    log.warn("关闭会话后折叠失败，保留原文件:", sessionId, formatError(error))
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
    log.error("读取会话元数据失败:", metadata.id, formatError(error))
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

/** 重命名会话（展示名持久化在会话文件里）；失败留证据但不阻断发送流程（不 reject，只返回 false）。 */
export async function persistPiSessionName(sessionId: string, name: string): Promise<boolean> {
  try {
    const session = await acquirePiSession(sessionId)
    await session.setName(name, BACKGROUND_CONTEXT)
    return true
  } catch (error) {
    // 用户数据没落盘：error 级 + reportError 留完整记录，调用方按返回值决定提示。
    log.error("会话重命名落盘失败:", sessionId, formatError(error))
    reportError("PiSession", error, { kind: "会话重命名落盘失败", overlay: false })
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
