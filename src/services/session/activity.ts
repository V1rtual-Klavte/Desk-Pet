// ==========================================
// 会话活动时间读取（列表排序用）
//
// 口径（用户 2026-10-06 拍板）：会话列表按**用户活动时间**排序 —— 取正文里**最后一条
// `role:"user"` 条目**的时间戳；助手的主动消息与自定义/控制条目都不算。没有用户消息的
// 会话回退 `createdAt`（见 compareSessionActivity）。
//
// 为什么不是文件 mtime：折叠（纯删除式重写）与重命名（value/set 行）都会推进 mtime，
// 而它们不是用户活动 —— mtime 作排序键会把「刚折叠过的旧会话」顶到列表顶部。活动时间
// 取自正文内容：折叠保留行逐字不变（entry 行一个不动）、重命名只追加 value 行，
// 两者都不产生新的 user 条目，活动时间天然不变。
//
// 读取纪律：只读文件尾部（`session_read_text` 的 tailBytes 模式，见 host/types.ts），
// 从末尾向前扫最后一条 user 条目；窗口不够就按 4 倍扩大，直到覆盖整个文件。带按
// (路径, 仓库扫描 mtime) 键控的缓存 —— 命中即不再触碰磁盘（见 readSessionActivityAt）。
// ==========================================

import { getHostBridge } from "@/services/host"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"
import { BaseDirs, relativeWithinRoot } from "@/services/paths"

const log = createLogger("SessionActivity")

/** 尾部扫描的初始窗口（字节）；绝大多数会话最后一条 user 条目都在这个距离内。 */
export const ACTIVITY_TAIL_INITIAL_BYTES = 64 * 1024

/**
 * 尾部扫描的窗口上限（字节）。与折叠的读取守卫同量级（`FOLD_POLICY.maxFileBytes` = 64 MiB）：
 * 更大窗口只影响「最后一条 user 条目距文件末尾极远」的角落会话，到顶后按无活动时间回退。
 */
export const ACTIVITY_TAIL_MAX_BYTES = 64 * 1024 * 1024

/**
 * 活动时间缓存：按**绝对路径**键控，值记录写入缓存的扫描 mtime 与扫描结果。
 *
 * 命中条件 = 传入的 `modifiedAt`（仓库列举的新鲜 mtime）与缓存一致 —— 文件 mtime 只随写入
 * 推进，一致即「自上次读取以来没有任何写入」这一前提**只在毫秒之上成立**：mtime 是毫秒整数
 * （Rust `modified().as_millis()`），同一毫秒内的写入不推进它。折叠与重命名会推进 mtime ⇒
 * 缓存失效重算，但重算结果与内容一致（不变）。
 *
 * 因此**只缓存扫到真实时间戳的结果，null（回退态）不缓存**：刚读过又立刻写入 user 条目时
 * （如 `createPiSession` 返回摘要的首读之后紧接着 append），毫秒 mtime 可能原地不动 ——
 * 命中的陈旧 null 会把「有用户活动」的会话按创建时间回退，是语义错误；数值态的同毫秒陈旧
 * 只是「晚一拍」（时间戳仍取自正文、偏差以毫秒计），按设计接受。代价：没有用户消息的会话
 * 每次摘要读都重扫尾部（窗口从 64 KiB 起步，空会话即整文件读完），为正确性接受。
 *
 * 容量：每个会话文件一条小记录，条目数有磁盘会话数上界（与列表本身同阶），不做淘汰。
 */
const activityCache = new Map<string, { modifiedAt: number; activityAt: number | null }>()

/**
 * 读取一个会话文件的活动时间（最后一条 user 条目时间戳；null = 没有用户消息）。
 *
 * `absolutePath` / `modifiedAt` 来自会话仓库列举（`JsonlStorageMetadata`）；读取失败或
 * 跨数据根时返回 null（列表按 createdAt 回退）并留痕（跨根除外，列举侧已留过痕）。
 */
export async function readSessionActivityAt(absolutePath: string, modifiedAt: number): Promise<number | null> {
  const cached = activityCache.get(absolutePath)
  if (cached && cached.modifiedAt === modifiedAt) return cached.activityAt
  // 路径未初始化（会话域早于 initPaths 的调用）与跨数据根的文件都不在会话命令的边界内
  // （跨根项列举侧已留过一次痕）——不在这里发明第二个边界判定，也不重复留痕。
  const sessionsRoot = BaseDirs.sessions()
  if (!sessionsRoot) return null
  const relative = relativeWithinRoot(sessionsRoot, absolutePath)
  if (relative === null) return null
  try {
    const activityAt = await scanTailForUserEntry(relative)
    // null（回退态）不写缓存：毫秒 mtime 判不出「扫描后同一毫秒又写入」，陈旧的 null 是
    // 语义错误（有活动按无活动回退），陈旧的数值只是晚一拍。见缓存块注释。
    if (activityAt !== null) activityCache.set(absolutePath, { modifiedAt, activityAt })
    return activityAt
  } catch (error) {
    // 失败不缓存（下次重试）；返回值让列表回退 createdAt —— 不拿旧缓存值冒充当前事实。
    log.warn("会话活动时间读取失败，按创建时间回退:", relative, formatError(error))
    return null
  }
}

/**
 * 从文件末尾分块向前扫描最后一条 user 条目。
 *
 * 每轮请求「最后 window 字节」（`session_read_text` 的 tailBytes 模式保证返回从行边界开始
 * 的整行文本）；没找到就把窗口扩 4 倍重读，直到响应**首行是会话头**（header 只可能是文件
 * 第一行 ⇒ 窗口已覆盖整个文件，此时还没有 user 条目就是确定没有）。不能用「两轮文本相同」
 * 这类启发式收口：窗口从长行中间起步会丢半行，扩窗后可能复现同一文本，导致把长行之前的
 * user 条目误判为不存在。
 *
 * 到窗口上限仍未见到文件头（病态体积或读取期间持续增长）按无活动时间回退并留痕；
 * 常规会话（最后一条 user 条目距末尾几 KiB 内）一轮即返回。
 */
async function scanTailForUserEntry(relativePath: string): Promise<number | null> {
  let window = ACTIVITY_TAIL_INITIAL_BYTES
  for (;;) {
    const text = await getHostBridge().request("session_read_text", { path: relativePath, tailBytes: window })
    const found = lastUserEntryTimestamp(text)
    if (found !== null) return found
    if (startsAtFileHead(text)) return null
    if (window >= ACTIVITY_TAIL_MAX_BYTES) {
      log.warn("会话活动时间扫描到达窗口上限，按创建时间回退:", relativePath, window)
      return null
    }
    window = Math.min(window * 4, ACTIVITY_TAIL_MAX_BYTES)
  }
}

/**
 * 响应首行是会话头（`kind:"header"`）⟺ 窗口覆盖了整个文件。
 * 空响应 = 窗口整体落在一个长行内部（起点 > 0 才会丢截断半行），不是文件头，继续扩窗。
 */
function startsAtFileHead(tailText: string): boolean {
  const newline = tailText.indexOf("\n")
  const firstLine = newline === -1 ? tailText : tailText.slice(0, newline)
  if (firstLine.length === 0) return false
  try {
    const parsed: unknown = JSON.parse(firstLine)
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as { kind?: unknown }).kind === "header"
    )
  } catch {
    // 首行不是完整 JSON（撕裂头/未知格式）：不能当作「已到文件头」，继续扩窗。
    return false
  }
}

/** 排序键：活动时间优先，没有用户消息（null/缺省）回退创建时间。 */
export interface SessionActivityKey {
  id: string
  createdAt: number
  activityAt?: number | null
}

/**
 * 会话列表排序比较器：活动时间降序（缺省回退 createdAt）；同值按 id 升序，保证多次
 * 刷新/不同输入顺序下的顺序稳定（并列会话不来回换位）。
 */
export function compareSessionActivity(left: SessionActivityKey, right: SessionActivityKey): number {
  const leftAt = left.activityAt ?? left.createdAt
  const rightAt = right.activityAt ?? right.createdAt
  return rightAt - leftAt || left.id.localeCompare(right.id)
}

/**
 * 文本尾部 → 最后一条 user 条目时间戳（null = 这段文本里没有）。
 *
 * 行形状即 JSONL 落盘形状（上游 `commitWrite` 产出）：一行是一条写或一个写数组，
 * entry 写在顶层带 `kind:"entry"` + `type:"message"` + `timestamp`，消息在 `message`
 * 里带 `role` 与可选 `timestamp`。时间戳取 `message.timestamp` 优先、回退条目级
 * `timestamp`（与 `read-model.ts` 的展示时间同口径）。
 *
 * 撕裂的最后一行（写入竞态窗口内可能读到半行）与不含目标键的行按「跳过」处理并继续
 * 向前扫 —— 它们不是读取失败，扫描的判据是「最后一条完整行里的 user 条目」。
 */
export function lastUserEntryTimestamp(tailText: string): number | null {
  const lines = tailText.split("\n")
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    // 便宜的预筛：只有含 user 角色的行才值得 JSON.parse（巨型工具结果行不解析）。
    if (line.length === 0 || !line.includes('"role":"user"')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const writes = Array.isArray(parsed) ? parsed : [parsed]
    for (let writeIndex = writes.length - 1; writeIndex >= 0; writeIndex--) {
      const timestamp = userEntryTimestamp(writes[writeIndex])
      if (timestamp !== null) return timestamp
    }
  }
  return null
}

/** 单条写是「user 消息条目」时返回其时间戳，否则 null。 */
function userEntryTimestamp(write: unknown): number | null {
  if (typeof write !== "object" || write === null) return null
  const record = write as { kind?: unknown; type?: unknown; timestamp?: unknown; message?: unknown }
  if (record.kind !== "entry" || record.type !== "message") return null
  const message = record.message
  if (typeof message !== "object" || message === null) return null
  if ((message as { role?: unknown }).role !== "user") return null
  const messageTimestamp = (message as { timestamp?: unknown }).timestamp
  if (typeof messageTimestamp === "number" && Number.isFinite(messageTimestamp)) return messageTimestamp
  return typeof record.timestamp === "number" && Number.isFinite(record.timestamp) ? record.timestamp : null
}
