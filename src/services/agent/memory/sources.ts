// ==========================================
// 记忆来源收集
// ==========================================
//
// 只有「用户本人的可信输入」能成为长期事实的候选。这个判断必须是纯函数：
// 它同时是自动提取与评测的准入闸门，藏在会话仓库后面就没法在快层单独验证。
// 读取条目（需要真 JSONL）、哈希与登记 IPC 都留在外层，纯选择器只认已读到的条目。

import { createLogger } from "@/services/logger"
import { listPiSessionMetadata, readPiSessionEntriesOnce } from "@/services/session/repo"
import { inputSourceOf, laneMessageText, messageEventId } from "@/services/engine/runtime"
import { registerMemorySources } from "./ipc"
import type { MemorySource } from "./ipc"

const log = createLogger("MemorySources")

type UnknownRecord = Record<string, unknown>

/** 证据片段上限：记忆只保留回溯所需的引文，绝不复制整段会话正文。 */
const EVIDENCE_CHARS = 2_000

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" ? (value as UnknownRecord) : undefined
}

async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")
}

function isMessageEntry(entry: UnknownRecord): boolean {
  return entry.type === "message"
}

/**
 * 从已读到的 Pi 条目里挑出可信来源（纯函数，不碰 IPC、不读盘）。
 *
 * 判据与 `InputSourceMark` 同一份词汇：origin=user、taint=trusted_user、
 * eligibleForMemory=true。工具结果、助手台词、压缩摘要与主动消息在这里一律出局 ——
 * 它们都可能很长很「像事实」，但没有任何一条能证明是用户本人说的。
 */
export function trustedSourcesFromEntries(
  sessionId: string,
  entries: readonly unknown[],
): (Omit<MemorySource, "contentHash"> & { rawText: string })[] {
  const sources: (Omit<MemorySource, "contentHash"> & { rawText: string })[] = []
  for (const raw of entries) {
    const entry = asRecord(raw)
    if (!entry || !isMessageEntry(entry)) continue
    const message = asRecord(entry.message)
    if (!message || message.role !== "user") continue
    const mark = inputSourceOf(message as { deskpetSource?: unknown })
    if (!mark || !mark.eligibleForMemory || mark.origin !== "user" || mark.taint !== "trusted_user") continue
    const text = laneMessageText(message as never).trim()
    if (!text) continue
    const entryId = typeof entry.id === "string" ? entry.id : ""
    const seq = typeof entry.seq === "number" ? entry.seq : -1
    // 没有稳定身份与序号的条目不能当水位与幂等键，直接跳过而不是编一个。
    if (!entryId || !Number.isSafeInteger(seq) || seq < 0) continue
    const eventId = messageEventId(message as { deskpetEventId?: unknown })
    if (!eventId) continue
    sources.push({
      sourceId: `${sessionId}:${entryId}`,
      sessionId,
      entryId,
      eventId,
      seq,
      // 当前 protocol 只承载 bounded evidence；完整 hash 在 collectMemorySources 中
      // 直接对原文计算，不能对截断片段 hash，否则同前缀的两条消息会被误认为同一来源。
      evidence: text.slice(0, EVIDENCE_CHARS),
      rawText: text,
      // 投递时刻冻结的 Card 身份：缺了它这段经历只能留在 user 范围，不能事后反推。
      ...(mark.cardId ? { cardId: mark.cardId } : {}),
      eligibleForMemory: true,
      taint: "trusted_user",
      origin: "user",
      observedAt: typeof entry.timestamp === "number" ? entry.timestamp : Date.now(),
    })
  }
  return sources
}

/** 读取一个会话并登记它的可信来源；Rust 会再核对资格与墓碑，被拒的不计数。 */
export async function collectMemorySources(sessionId: string): Promise<MemorySource[]> {
  const entries = await readPiSessionEntriesOnce(sessionId)
  const selected = trustedSourcesFromEntries(sessionId, entries as unknown as unknown[])
  const sources: (MemorySource & { rawText: string })[] = []
  for (const partial of selected) {
    sources.push({ ...partial, contentHash: await sha256(partial.rawText) })
  }
  await registerMemorySources(sources)
  return sources.map(({ rawText: _rawText, ...source }) => source)
}

export async function collectAllMemorySources(): Promise<MemorySource[]> {
  const metadata = await listPiSessionMetadata()
  const all: MemorySource[] = []
  for (const session of metadata) {
    try {
      all.push(...(await collectMemorySources(session.id)))
    } catch (error) {
      // 读不到的会话不推进水位、也不冒充「这个会话没有记忆」：把范围如实交回调用方。
      log.warn("记忆来源收集失败:", { sessionId: session.id }, error)
    }
  }
  return all
}
