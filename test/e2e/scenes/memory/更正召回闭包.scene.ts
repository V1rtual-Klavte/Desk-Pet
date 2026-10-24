import { createHash } from "node:crypto"
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core"
import type { Entry } from "@earendil-works/pi-agent-core"
import type { SceneDef } from "../../../e2e/types"
import { fakeText, installFakeProvider } from "../../../host/fake-provider"
import { applyMemoryChange, memoryStatus, registerMemorySources } from "@/services/agent/memory"
import type { MemorySource } from "@/services/agent/memory"
import { searchConversationCandidates } from "@/services/agent/memory/conversation"
import { MEMORY_CITATIONS_ENTRY } from "@/services/engine/runtime"
import { getHostBridge } from "@/services/host"
import { appendPiSessionCustomEntry, createPiSession, PI_LANE } from "@/services/session"
import { acquirePiSession } from "@/services/session/repo"

// 证据句与助手转述刻意不共享词面：检索只能命中助手转述，才能证明隐藏来自引用溯源，
// 而不是原始用户句也被词面打中。
const HOME_SOURCE = "我老家在临海古城，小时候常去江边看船。"
const HOME_FACT = "用户的老家在临海古城"
const HOME_CORRECTED_FACT = "用户的老家在宁海古城"
const HOME_PARAPHRASE = "你之前说过童年在江畔看船的日子。"
const TEA_SOURCE = "我平常只喝乌龙茶，不太碰咖啡。"
const TEA_FACT = "用户喜欢喝乌龙茶"
const TEA_PARAPHRASE = "你提到过偏爱半发酵的茶。"

let trialIdentity = ""

type SessionHandle = Awaited<ReturnType<typeof acquirePiSession>>
type LaneBranch = NonNullable<Awaited<ReturnType<SessionHandle["branch"]>>>

interface SeededSession {
  sessionId: string
  session: SessionHandle
  branch: LaneBranch
}

async function openBranch(sessionId: string): Promise<SeededSession> {
  const session = await acquirePiSession(sessionId)
  const branch = await session.branch(PI_LANE, BACKGROUND_CONTEXT)
    ?? await session.createBranch(PI_LANE, null, BACKGROUND_CONTEXT)
  return { sessionId, session, branch }
}

async function appendUser(seeded: SeededSession, text: string): Promise<Entry> {
  const id = await seeded.branch.appendMessage({
    role: "user",
    content: text,
    timestamp: Date.now(),
  } as never, BACKGROUND_CONTEXT)
  const entry = await seeded.session.getEntry(id, BACKGROUND_CONTEXT)
  if (!entry || entry.type !== "message" || entry.message.role !== "user") {
    throw new Error(`用户证据条目未按预期落盘: ${id}`)
  }
  return entry
}

async function appendAssistant(seeded: SeededSession, text: string): Promise<string> {
  return seeded.branch.appendMessage({
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  } as never, BACKGROUND_CONTEXT)
}

function sourceFor(seeded: SeededSession, entry: Entry, seed: string): MemorySource {
  if (entry.type !== "message" || entry.message.role !== "user" || typeof entry.message.content !== "string") {
    throw new Error("关键原话不是可引用的用户文本条目")
  }
  const text = entry.message.content
  return {
    sourceId: `${seeded.sessionId}:${entry.id}:${seed}`,
    sessionId: seeded.sessionId,
    entryId: entry.id,
    eventId: `${trialIdentity}:${seed}:user`,
    seq: entry.seq,
    contentHash: createHash("sha256").update(text.trim()).digest("hex"),
    evidence: text.slice(0, 80),
    sourceLength: text.length,
    eligibleForMemory: true,
    taint: "trusted_user",
    origin: "user",
    observedAt: typeof entry.message.timestamp === "number" ? entry.message.timestamp : Date.now(),
  }
}

async function addFact(itemId: string, content: string, source: MemorySource): Promise<void> {
  await applyMemoryChange({
    operationId: `${trialIdentity}:${itemId}:add`,
    baseRevision: (await memoryStatus()).revision,
    action: "add",
    actor: "internal",
    itemId,
    draft: {
      content,
      summary: content,
      kind: "fact",
      scope: "user",
      aliases: [],
      pinned: false,
      importance: 5,
      confidence: 1,
      sourceIds: [source.sourceId],
    },
  })
}

async function search(targetSessionId: string, query: string): Promise<Set<string>> {
  const result = await searchConversationCandidates({
    sessionId: targetSessionId,
    queries: [query],
    signal: new AbortController().signal,
  })
  return new Set(result.entries.map(entry => entry.entryId))
}

/**
 * 跨会话引用溯源的真实 SQL 闭包。
 *
 * 对照关系必须是「同会话原话 → 跨会话助手转述」：`SUPERSEDED_SOURCE_EXISTS` 只按锚点
 * 隐藏同轮助手，若把来源和转述放在同一会话，测试会由既有闭包通过，无法证明 quote refs。
 * 因此证据原话在来源会话，助手转述在目标会话，转述只通过 deskpet.memory_citations 的
 * conversationRefs 与来源条目相连。
 */
export const 更正召回闭包: SceneDef = {
  meta: {
    caseId: "memory-correction-recall-closure",
    module: "memory",
    contractId: "mm-81",
    description: "真实 SQLite 中，跨会话助手转述只有引用溯源相连；来源记忆被内容更正或遗忘后转述退出检索，同值置顶更新不隐藏，重建索引后闭包仍成立",
    depth: "deep",
    suite: "regression",
    entry: "runtime",
    tags: ["memory", "boundary", "storage"],
  },
  setup: async () => {
    trialIdentity = crypto.randomUUID()
    installFakeProvider([fakeText("收到。")])
  },
  turns: [
    {
      index: 1,
      description: "跨会话转述的更正/遗忘闭包与同值更新负对照",
      userText: "核对引用溯源闭包。",
      checks: [
        {
          type: "expectCrossSessionQuoteClosure",
          run: async () => {
            const sourceSession = await createPiSession(`闭包来源-${trialIdentity}`)
            const targetSession = await createPiSession(`闭包目标-${trialIdentity}`)
            const source = await openBranch(sourceSession.id)
            const target = await openBranch(targetSession.id)

            const homeEntry = await appendUser(source, HOME_SOURCE)
            const teaEntry = await appendUser(source, TEA_SOURCE)
            const homeSource = sourceFor(source, homeEntry, "home")
            const teaSource = sourceFor(source, teaEntry, "tea")
            const registered = await registerMemorySources([homeSource, teaSource])
            if (registered !== 2) throw new Error(`来源登记 ${registered} 条，期望 2`)
            const homeItemId = `${trialIdentity}:home`
            const teaItemId = `${trialIdentity}:tea`
            await addFact(homeItemId, HOME_FACT, homeSource)
            await addFact(teaItemId, TEA_FACT, teaSource)

            // 目标会话的两轮：用户问题与助手转述。转述不含来源句的词面特征，
            // 检索命中后是否可见只能由 conversationRefs 的闭包决定。
            await appendUser(target, "我小时候住在哪里？")
            const homeReply = await appendAssistant(target, HOME_PARAPHRASE)
            await appendPiSessionCustomEntry(targetSession.id, MEMORY_CITATIONS_ENTRY, {
              assistantEntryId: homeReply,
              itemIds: [],
              conversationRefs: [{ sessionId: sourceSession.id, entryId: homeEntry.id }],
              requestId: `${trialIdentity}:home`,
            } as never)
            await appendUser(target, "我平时喝茶有什么偏好？")
            const teaReply = await appendAssistant(target, TEA_PARAPHRASE)
            await appendPiSessionCustomEntry(targetSession.id, MEMORY_CITATIONS_ENTRY, {
              assistantEntryId: teaReply,
              itemIds: [],
              conversationRefs: [{ sessionId: sourceSession.id, entryId: teaEntry.id }],
              requestId: `${trialIdentity}:tea`,
            } as never)

            const homeQuery = "江畔"
            const teaQuery = "半发酵"
            const initialHome = await search(targetSession.id, homeQuery)
            const initialTea = await search(targetSession.id, teaQuery)
            if (!initialHome.has(homeReply) || !initialTea.has(teaReply)) {
              throw new Error(`引用转述初始应可见: home=${initialHome.has(homeReply)}, tea=${initialTea.has(teaReply)}`)
            }

            // 同值置顶更新只改元数据：内容、摘要与时间锚都没有变化，闭包不得误杀。
            await applyMemoryChange({
              operationId: `${trialIdentity}:home:pin`,
              baseRevision: (await memoryStatus()).revision,
              action: "update",
              actor: "internal",
              itemId: homeItemId,
              expectedVersion: 1,
              draft: {
                content: HOME_FACT,
                summary: HOME_FACT,
                kind: "fact",
                scope: "user",
                aliases: [],
                pinned: true,
                importance: 5,
                confidence: 1,
                sourceIds: [homeSource.sourceId],
              },
            })
            if (!(await search(targetSession.id, homeQuery)).has(homeReply)) {
              throw new Error("同值置顶更新后引用转述被错误隐藏")
            }

            // 内容更正：来源版本不再是当前活动值，跨会话转述退出检索。
            await applyMemoryChange({
              operationId: `${trialIdentity}:home:correct`,
              baseRevision: (await memoryStatus()).revision,
              action: "supersede",
              actor: "internal",
              itemId: homeItemId,
              expectedVersion: 2,
              draft: {
                content: HOME_CORRECTED_FACT,
                summary: HOME_CORRECTED_FACT,
                kind: "fact",
                scope: "user",
                aliases: [],
                pinned: true,
                importance: 5,
                confidence: 1,
                sourceIds: [homeSource.sourceId],
              },
            })
            if ((await search(targetSession.id, homeQuery)).has(homeReply)) {
              throw new Error("来源事实被内容更正后跨会话转述仍可召回")
            }

            // 遗忘：真实 forget 会为条目来源写 block_extraction 墓碑，转述按 quote ref 退出。
            await applyMemoryChange({
              operationId: `${trialIdentity}:tea:forget`,
              baseRevision: (await memoryStatus()).revision,
              action: "forget",
              actor: "internal",
              itemId: teaItemId,
            })
            if ((await search(targetSession.id, teaQuery)).has(teaReply)) {
              throw new Error("来源被遗忘后跨会话转述仍可召回")
            }

            // 强制丢弃目标会话索引后重检：闭包必须由 citation 条目重建，而不是索引残留。
            await getHostBridge().request("conversation_index_prune", { sessionIds: [sourceSession.id] })
            const afterRebuildHome = await search(targetSession.id, homeQuery)
            const afterRebuildTea = await search(targetSession.id, teaQuery)
            if (afterRebuildHome.has(homeReply) || afterRebuildTea.has(teaReply)) {
              throw new Error("索引重建后已失效的跨会话转述重新出现")
            }
            const status = await getHostBridge().request("conversation_index_status", {})
            if (!status.sessions.some(item => item.sessionId === targetSession.id)) {
              throw new Error("目标会话索引未在重检时重建")
            }
          },
        },
      ],
    },
  ],
}

export default 更正召回闭包
