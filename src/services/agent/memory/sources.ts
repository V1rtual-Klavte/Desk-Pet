// ==========================================
// 记忆来源收集
// ==========================================
//
// 长期记忆只有两类准入来源（2026-10-06 用户裁决「方案 b」）：
// 1. `origin=user` + `taint=trusted_user`：用户本人的可信输入（识别判断是纯函数，
//    它同时是自动提取与评测的准入闸门，藏在会话仓库后面就没法在快层单独验证）；
// 2. `origin=derived_behavior` + `taint=derived`：行为画像层已算出的**稳定结论**
//    （`sedimentConclusions` 的产出，只在 reliable 档存在）——语义是「系统观察得出的、
//    可撤销的结论」，与用户事实分区存放、分区召回，永不冒充用户原话。
// 读取条目（需要真 JSONL）、哈希与登记 IPC 都留在外层，纯选择器只认已读到的条目。

import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"
import { getBehaviorSnapshot, sedimentConclusions } from "@/services/behavior"
import { listPiSessionMetadata, readPiSessionEntriesOnce } from "@/services/session/repo"
import { inputSourceOf, laneMessageText, messageEventId } from "@/services/engine/runtime"
import { registerMemorySources } from "./ipc"
import type { MemorySource } from "./ipc"

const log = createLogger("MemorySources")

/** 派生来源类别（与 protocol.json 的 MemoryOrigin 同词汇）。 */
export const DERIVED_BEHAVIOR_ORIGIN = "derived_behavior" as const
/** 派生结论来源的合成会话身份：与真实 sessionId 空间不相交，水位独立记账。 */
export const BEHAVIOR_CONCLUSION_SESSION = "behavior"
/** 派生结论来源的条目身份前缀（`conclusion:<slot>`），槽位即画像组（rhythm/apps/focus/activity）。 */
export const BEHAVIOR_CONCLUSION_ENTRY_PREFIX = "conclusion:"

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
      sourceLength: text.length,
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

/** Resolve only the source attached to the currently committed trusted ingress. */
export async function resolveCurrentTrustedMemorySource(sessionId: string, eventId: string): Promise<MemorySource> {
  if (!sessionId || !eventId) throw new Error("缺少当前可信用户事件身份")
  const matches = (await collectMemorySources(sessionId)).filter(source => source.eventId === eventId)
  if (matches.length !== 1) throw new Error("当前可信用户来源缺失或不唯一")
  return matches[0]!
}

export async function collectAllMemorySources(): Promise<MemorySource[]> {
  const metadata = await listPiSessionMetadata()
  const all: MemorySource[] = []
  for (const session of metadata) {
    try {
      all.push(...(await collectMemorySources(session.id)))
    } catch (error) {
      // 读不到的会话不推进水位、也不冒充「这个会话没有记忆」：把范围如实交回调用方。
      log.warn("记忆来源收集失败:", { sessionId: session.id }, formatError(error))
    }
  }
  return all
}

/** 派生来源判定：统一从 origin 读，不在调用点各写一份字符串比较。 */
export function isDerivedBehaviorSource(source: Pick<MemorySource, "origin">): boolean {
  return source.origin === DERIVED_BEHAVIOR_ORIGIN
}

/** 从派生来源的条目身份里取结论槽位（`conclusion:<slot>`）；非派生来源返回 undefined。 */
export function conclusionSlotOf(source: Pick<MemorySource, "origin" | "entryId">): string | undefined {
  if (!isDerivedBehaviorSource(source)) return undefined
  if (!source.entryId.startsWith(BEHAVIOR_CONCLUSION_ENTRY_PREFIX)) return undefined
  const slot = source.entryId.slice(BEHAVIOR_CONCLUSION_ENTRY_PREFIX.length)
  return slot || undefined
}

/**
 * 收集行为画像的稳定结论并登记为 `derived_behavior` 来源。
 *
 * - 准入闸门只有一个：`sedimentConclusions` 只在 reliable 档产出结论 ——
 *   非 reliable（unavailable/insufficient）时这里返回空数组、**不登记任何来源**，
 *   原始观察不可能经由本函数进入记忆。
 * - 身份与版本：sourceId / eventId 含结论文本的 hash —— 同一份结论重复登记是幂等的；
 *   文本变化（新数据推翻 / 修正旧结论）就是新的来源版本，由整理覆盖旧条目。
 * - seq 取登记时刻（毫秒，跨重启单调）：水位按（会话 = `behavior`，seq）推进。
 * - 内容变化时旧来源行保留（旧条目版本仍引用它），与用户来源同一口径。
 */
export async function collectBehaviorMemorySources(now = Date.now()): Promise<MemorySource[]> {
  const conclusions = sedimentConclusions(getBehaviorSnapshot(now))
  if (conclusions.length === 0) return []
  const sources: (MemorySource & { rawText: string })[] = []
  for (const conclusion of conclusions) {
    const hash = await sha256(conclusion.text)
    const identity = `${conclusion.slot}:${hash.slice(0, 16)}`
    sources.push({
      sourceId: `behavior-conclusion:${identity}`,
      sessionId: BEHAVIOR_CONCLUSION_SESSION,
      entryId: `${BEHAVIOR_CONCLUSION_ENTRY_PREFIX}${conclusion.slot}`,
      eventId: `behavior:${identity}`,
      seq: now,
      contentHash: hash,
      evidence: conclusion.text.slice(0, EVIDENCE_CHARS),
      sourceLength: conclusion.text.length,
      rawText: conclusion.text,
      eligibleForMemory: true,
      taint: "derived",
      origin: DERIVED_BEHAVIOR_ORIGIN,
      observedAt: now,
    })
  }
  await registerMemorySources(sources.map(({ rawText: _rawText, ...source }) => source))
  return sources.map(({ rawText: _rawText, ...source }) => source)
}
