// ==========================================
// 折叠完整性场景（T6.01 / 源项 X-2）—— 压缩过的会话经真实折叠后，条目一条不少且逐字不变
//
// X-2 的口径：压缩与存储两侧都不许删原文。
//   · 压缩侧「只换请求视图、原文条目保留」由 `memory-compaction-checkpoint` 钉；
//   · 存储侧「折叠只删确定可丢的整行，entry 行一个不动」由 `harness-session-log-fold` /
//     `harness-session-log-fold-crash` 钉。
// 但 W5 的三个折叠场景都在 `scenes/harness-storage/`、`meta.module: "harness-storage"`，挂不上
// memory 的 `mm-19`（`contract-checker.ts` 强制 `scene.meta.module === contract.module`），
// 且它们的夹具都是「真条目 + 直接 append 的帧」——**没有任何现有场景同时经历压缩与折叠**。
// 本场景补上这个组合：真实生产回合 → 手动压缩（`/compact` 的同一条入口）→ 生产折叠入口。
//
// 断言三条（X-2；地址逐字不变归 X-1，`harness-session-fold-address` 已钉，这里不重复声明）：
//   ① 压缩前已有的**全部**条目 id 与 `JSON.stringify(entry)` 逐字不变；
//   ② compaction 条目仍在（折叠前快照里显式数出条数 —— 「快照里恰好没有它」是空断言，判失败）；
//   ③ `sessionMessages()` 的用户/助手正文序列逐字不变。
//
// 夹具必须真的折叠：`foldSession` 返回 skipped 时本场景判失败并把 kind/reason 写进错误文案 ——
// 没折叠就等于在比较「同一份没变过的数据」，三条断言全部退化成空断言。规模全部由当前窗口的
// `compactionSettingsFor` 与 `FOLD_POLICY` 推导（不写死条数），并在 setup 里复核两条前提
// （切点关系、闸门 1/2 余量）：前提不成立时失败在可读原因上，而不是让断言去猜。
//
// 折叠的执行契约要求「该文件当前没有写入者」（`session-fold.ts` 的 `foldSessionFile` 前置条件）。
// 生产关闭路径（`releasePiSession`）自带一次折叠，会先把可折叠状态消费掉 —— 所以这里先显式关闭
// 原始句柄（与 `harness.close` 关闭会话的效果同形：上游 `Session.close` 幂等、仓库侧注册表随
// `onClose` 释放），再走同一条生产折叠入口 `repo.foldSession(metadata)`；折叠后经
// `releasePiSession` 释放句柄缓存，由会话层重新 open —— 下面读到的条目确实来自折叠后的文件。
//
// 载荷三段（全部按当前窗口推导；上游 `findCutPoint` 按每条消息的 chars/4 从尾部累加）：
//   · 长回复 = 36% 保留窗口、长正文 = 18%：尾部四条消息 = 108%、尾部三条 = 90%
//     ⇒ 切点稳定落在「倒数第二轮的正文（user）」上，摘要范围 = 第一轮（非空，completed 而非 declined）。
//   · 长回复同时是折叠唯一的大宗可回收量：每个流式 delta 一行帧 append，回复结束时
//     `list/delete`（`operationCleanupWrites`）让整段成为死 key ⇒ 整段可回收。
//   · 正文与回复都留在会话文件里，是「折叠不许动原文」比对的对象。
// `entry: "production"`：回合经 `sendMessage()`，压缩与折叠都走生产入口。
// ==========================================

import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core"
import type { FileError, JsonlSessionMetadata, Result } from "@earendil-works/pi-agent-core"
import type { Context, FauxModelDefinition, FauxResponseStep } from "@earendil-works/pi-ai"
import { aiConfig } from "@/services/config"
import { initChat } from "@/services/agent/runner"
import {
  FOLD_POLICY,
  compactActiveSession,
  compactionSettingsFor,
  flushSessionFrameWrites,
  harnessSlots,
  prepareFold,
  readFoldLog,
} from "@/services/engine/pi"
import {
  acquirePiSession,
  getActiveSessionId,
  getPiSessionRepo,
  listPiSessionMetadata,
  releasePiSession,
} from "@/services/session"
import { runtimePath } from "@/services/paths"
import { TauriExecutionEnv } from "@/services/tool/pi/tauri-execution-env"
import { installFakeProvider, fakeText, lastRequestText } from "../../../host/fake-provider"
import { assistantTexts, compactionEntries, sessionEntries, sessionMessages, userTexts } from "../../../host/session-entries"
import type { AssertContext, SceneDef } from "../../../host/types"

const utf8 = new TextEncoder()

// ── 载荷推导（按当前窗口与折叠策略推导，不写死条数）──

/** 真正生效的窗口与 resolvePiTurnModel 一致：配置值与注入模型窗口取小。 */
const FAKE_MODEL: FauxModelDefinition = { id: "deskpet-fake", name: "Desk-Pet Fake", contextWindow: 131_072, maxTokens: 16_384 }
const WINDOW_TOKENS = Math.min(aiConfig.contextMaxTokens, 131_072)
const SETTINGS = compactionSettingsFor(WINDOW_TOKENS)
/** 上游保留窗口：`pi-agent-core/compaction.js` 的 `estimateTokens` 是每条消息的字符数 / 4。 */
const KEEP_TOKENS = SETTINGS.keepRecentTokens
const CHARS_PER_TOKEN = 4

const NUMERALS = ["一", "二", "三", "四", "五", "六", "七", "八", "九"]

/** 用户正文的重复单元（中文 16 字符；UTF-8 3 字节/字符，字节与 token 两种口径都不亏）。 */
const UNIT = "压缩折叠探针正文必须留在磁盘中。"
/** 第一轮历史：首条之后才有可摘要范围，它本身只需是一段像样的早期正文（口径同 压缩检查点）。 */
const FIRST = `用户第一轮：${UNIT.repeat(133)}`
/** 长正文 = 保留窗口的 18%（chars/4 口径）。 */
const LONG_SHARE = 0.18
const LONG = UNIT.repeat(Math.ceil((KEEP_TOKENS * CHARS_PER_TOKEN * LONG_SHARE) / UNIT.length))

/** 长回复 = 保留窗口的 36%（chars/4 口径）：尾部「两条长回复 + 一条长正文」= 90% 不越过保留窗口。 */
const REPLY_SHARE = 0.36
const REPLY_CHARS = Math.ceil(KEEP_TOKENS * CHARS_PER_TOKEN * REPLY_SHARE)
const REPLY_PAD = "compaction fold integrity probe payload "   // ASCII 40 字符
/** 第 index 轮的长回复：长度精确等于 REPLY_CHARS，逐轮可区分（正文序列比对要能看出换位/丢失）。 */
function longReply(index: number): string {
  const head = `第 ${index} 轮长回复：`
  const pad = REPLY_PAD.repeat(Math.ceil((REPLY_CHARS - head.length) / REPLY_PAD.length))
  return `${head}${pad.slice(0, REPLY_CHARS - head.length)}`
}

/** 一帧增量行的保守字节下界（实测 16 字符 delta ≈ 205 B：固定结构 ≈ 190 B + delta）。 */
const FRAME_ROW_MIN_BYTES = 160
/** faux provider 的单帧切片上限（3–5 token × 4 字符/token ⇒ 12–20 字符）。 */
const FRAME_CHARS_MAX = 20
/** 一条长回复的帧可回收字节的保守下界（帧行固定结构 + 切片字符）。 */
const REPLY_FRAME_BYTES_MIN = Math.floor(REPLY_CHARS / FRAME_CHARS_MAX) * FRAME_ROW_MIN_BYTES
/** 折叠回收量对闸门 2 的余量。 */
const FOLD_RECLAIM_MARGIN = 2
/** 需要几条长回复的帧才越过闸门 2（由 FOLD_POLICY 反推）。 */
const LONG_REPLIES_NEEDED = Math.ceil((FOLD_POLICY.minReclaimBytes * FOLD_RECLAIM_MARGIN) / REPLY_FRAME_BYTES_MIN)
/** 轮数：压缩切点至少要「两整轮 + 一条更早的历史」；每多一轮就多一条长回复的帧。 */
const TURNS = Math.max(3, LONG_REPLIES_NEEDED + 1)

function turnUserText(index: number): string {
  return index === 1 ? FIRST : `用户第${NUMERALS[index - 1] ?? index}轮：${LONG}`
}

const SUMMARY_MARKER = "压缩折叠组合断言的结构化摘要"

/** 最后一条脚本响应专供 before_compaction 的摘要请求；被别的请求取走就是脚本错位，立即报错。 */
const summaryStep: FauxResponseStep = context => {
  const text = lastRequestText(context)
  if (!text.includes("\"instructions\"")) throw new Error(`摘要脚本被非摘要请求取走: ${text.slice(0, 60)}`)
  return fakeText(JSON.stringify({
    intent: SUMMARY_MARKER,
    facts: ["压缩过的会话文件折叠后条目必须逐字不变"],
    corrections: [],
    pending: ["核对折叠后的条目 id 与正文"],
    continuity: ["本次使用 fake provider"],
    nextSteps: ["比对折叠前后的条目快照"],
  }))
}

/** 断言失败时带上真实口径，别让人从「未覆盖」反推载荷问题。 */
function sizing(): string {
  return `窗口 ${WINDOW_TOKENS}、保留窗口 ${KEEP_TOKENS}`
    + `；长回复 ${REPLY_CHARS} 字符（${(REPLY_CHARS / CHARS_PER_TOKEN / KEEP_TOKENS).toFixed(2)} 保留窗口）`
    + `、长正文 ${LONG.length} 字符（${(LONG.length / CHARS_PER_TOKEN / KEEP_TOKENS).toFixed(2)} 保留窗口）`
    + `；共 ${TURNS} 轮 / 长回复 ${TURNS - 1} 条`
    + `、帧可回收量保守下界 ${(TURNS - 1) * REPLY_FRAME_BYTES_MIN} B（闸门 2 = ${FOLD_POLICY.minReclaimBytes} B）`
}

/**
 * 载荷前提（常量全部由窗口与 FOLD_POLICY 推导，这里显式复核两条关系）：
 * 前提不成立时 scene 前置就失败 —— 否则压缩会按 declined 收尾、折叠会按 skipped 收尾，
 * 下面的断言全部退化。放在 setup 里报出真实数字。
 */
function assertPayloadPremise(): void {
  const replyTokens = Math.ceil(REPLY_CHARS / CHARS_PER_TOKEN)
  const longTokens = Math.ceil(LONG.length / CHARS_PER_TOKEN)
  // ① 切点关系：尾部 4 条消息越过保留窗口、尾部 3 条不越过 ⇒ 切点落在倒数第二轮的正文（user）上。
  if (2 * replyTokens + longTokens >= KEEP_TOKENS || 2 * replyTokens + 2 * longTokens < KEEP_TOKENS) {
    throw new Error(`场景载荷前提不成立：切点关系被打破（2×长回复 ${2 * replyTokens} + 长正文 ${longTokens}`
      + ` = ${2 * replyTokens + longTokens}、2×长回复 + 2×长正文 = ${2 * replyTokens + 2 * longTokens}`
      + `，保留窗口 ${KEEP_TOKENS}）｜${sizing()}`)
  }
  // ② 折叠关系：长回复帧的保守可回收量越过闸门 2 并留 FOLD_RECLAIM_MARGIN 倍余量。
  if ((TURNS - 1) * REPLY_FRAME_BYTES_MIN < FOLD_POLICY.minReclaimBytes * FOLD_RECLAIM_MARGIN) {
    throw new Error(`场景载荷前提不成立：长回复帧的可回收量不足（${(TURNS - 1) * REPLY_FRAME_BYTES_MIN} B < `
      + `${FOLD_POLICY.minReclaimBytes} × ${FOLD_RECLAIM_MARGIN}）｜${sizing()}`)
  }
  // ③ 闸门 1：保守体积（用户正文 + 回复条目 + 帧）也必须越过 minFileBytes。
  const bytes = utf8.encode(FIRST).byteLength + (TURNS - 1) * utf8.encode(LONG).byteLength
    + (TURNS - 1) * REPLY_CHARS + (TURNS - 1) * REPLY_FRAME_BYTES_MIN
  if (bytes <= FOLD_POLICY.minFileBytes) {
    throw new Error(`场景载荷前提不成立：保守体积 ${bytes} B 未过闸门 1（${FOLD_POLICY.minFileBytes} B）｜${sizing()}`)
  }
}

// ── 会话快照与盘上读取 ──

/** 会话条目快照：条目 id → JSON（逐字比对的判据）+ 聊天视图的用户/助手正文序列。 */
interface EntrySnapshot {
  entries: Map<string, string>
  /** 快照里的 compaction 条目 id：显式数出来，「快照里恰好没有它」是空断言。 */
  compactionIds: string[]
  users: string[]
  assistants: string[]
}

async function captureSession(sessionId: string): Promise<EntrySnapshot> {
  const entries = await sessionEntries(sessionId)
  const messages = await sessionMessages(sessionId)
  const byId = new Map<string, string>()
  for (const entry of entries) byId.set(entry.id, JSON.stringify(entry))
  return {
    entries: byId,
    compactionIds: compactionEntries(entries).map(entry => entry.id),
    users: userTexts(messages),
    assistants: assistantTexts(messages),
  }
}

function fileOk<T>(result: Result<T, FileError>): T {
  if (!result.ok) throw new Error(`期望成功，实际失败: ${result.error.message}`)
  return result.value
}

/** 盘上全文与字节（未包装的 env 直读；调用方先冲帧缓冲）。 */
async function readOnDisk(path: string): Promise<{ text: string; bytes: number }> {
  const plain = new TauriExecutionEnv(await runtimePath("data"))
  const info = fileOk(await plain.fileInfo(path, BACKGROUND_CONTEXT))
  const text = fileOk(await plain.readTextFile(path, BACKGROUND_CONTEXT))
  return { text, bytes: info.size }
}

/** 错误文案里的条目身份：条目可能带着几万字符的正文，报告里只留 id 与序列化长度。 */
function entryBrief(id: string, json: string): string {
  return `#${id}(${json.length} 字符)`
}

/** 两份序列化的首个差异位置：改写对照用，避免把整份正文塞进错误消息。 */
function divergence(before: string, after: string): string {
  let index = 0
  while (index < before.length && index < after.length && before[index] === after[index]) index++
  return `首个差异在第 ${index} 字符：before=${JSON.stringify(before.slice(index, index + 120))}`
    + ` after=${JSON.stringify(after.slice(index, index + 120))}`
}

// ── 跨 check 的夹具状态（模块级变量跨 trial 存活，按 trial 记名）──

/** 压缩前的条目快照：X-2 的①按最严口径比对（压缩与折叠两步都不许动这些条目）。 */
let preCompactionSnapshot: { trial: number; sessionId: string; entries: Map<string, string> } | undefined

/** 折叠前的夹具：盘上快照 + 条目快照 + 会话 metadata。 */
interface FoldFixture {
  trial: number
  sessionId: string
  metadata: JsonlSessionMetadata
  /** 压缩前已有的条目。 */
  preCompaction: Map<string, string>
  /** 折叠前已有的全部条目（含 compaction 条目）与聊天视图。 */
  beforeFold: EntrySnapshot
  bytesOnDisk: number
}

let fixture: FoldFixture | undefined

export const 折叠完整性: SceneDef = {
  meta: {
    caseId: "memory-compaction-fold-integrity",
    module: "memory",
    contractId: "mm-19",
    description: "压缩过的会话经生产折叠入口后：压缩前已有的条目一条不少且逐字不变、compaction 条目仍在、聊天视图正文序列不变",
    depth: "deep",
    suite: "regression",
    entry: "production",
    // 长回复的流式帧按帧落盘（每条回复上千帧）再加一次约 1 MB 的折叠重写，
    // 比默认 120s 宽一档，避免 WebView 抖动把生产断言记成超时。
    timeout: 180_000,
    tags: ["memory", "compaction", "session-fold"],
  },
  setup: async () => {
    assertPayloadPremise()
    preCompactionSnapshot = undefined
    fixture = undefined
    installFakeProvider([
      () => fakeText("第一轮回复完成。"),
      ...Array.from({ length: TURNS - 1 }, (_, offset) => () => fakeText(longReply(offset + 2))),
      summaryStep,
    ], FAKE_MODEL)
    await initChat()
  },
  turns: [
    ...Array.from({ length: TURNS - 1 }, (_, offset) => {
      const index = offset + 1
      return {
        index,
        description: `铺垫第 ${index} 轮历史`,
        userText: turnUserText(index),
        checks: [{ type: "expectTurnCompleted", run: async (context: AssertContext) => {
          if (!context.output.reply.trim()) throw new Error(`第 ${index} 轮没有回复`)
        } }],
      }
    }),
    {
      index: TURNS,
      description: "手动压缩后折叠：压缩前已有的条目逐字不变、compaction 条目仍在、聊天视图不变",
      userText: turnUserText(TURNS),
      checks: [
        {
          // 压缩侧：与 `/compact` 同一条入口（`compactCommand` 调的就是它）；成功才继续，
          // 失败/未完成都要给出可读原因（载荷前提不成立时在这里显形，而不是让折叠断言去猜）。
          type: "expectManualCompactionCompleted",
          run: async ctx => {
            const sessionId = getActiveSessionId()
            preCompactionSnapshot = undefined
            fixture = undefined
            const preCompaction = await captureSession(sessionId)

            const outcome = await compactActiveSession(sessionId)
            if (outcome.status !== "completed") {
              throw new Error(outcome.status === "failed"
                ? `手动压缩失败: ${outcome.error ?? "未知原因"}｜${sizing()}`
                : `手动压缩未完成: ${outcome.status}（空可摘要范围：尾部两整轮需越过 keepRecentTokens=${KEEP_TOKENS} 的 chars/4 估算）｜${sizing()}`)
            }

            const entries = await sessionEntries(sessionId)
            const compactions = compactionEntries(entries)
            // 恰好一条：多出来说明载荷在场景准备阶段就触发了自动压缩，本场景证明的就不是「这次手动压缩」。
            if (compactions.length !== 1) {
              throw new Error(`压缩条目应为 1 条（本次手动压缩），实际 ${compactions.length} 条｜${sizing()}`)
            }
            const compaction = compactions[0]!
            if (!compaction.fromHook) throw new Error("压缩条目不是由宿主 before_compaction 内核提交")
            if (!compaction.summary.includes(SUMMARY_MARKER)) {
              throw new Error("压缩条目的摘要不是本次脚本的结构化摘要（摘要脚本可能被别的请求取走）")
            }
            preCompactionSnapshot = { trial: ctx.trial, sessionId, entries: preCompaction.entries }
          },
        },
        {
          // 折叠侧前提：先收干在飞写入（审计队列、lane 操作、帧缓冲），再取折叠前的盘上快照，
          // 并用生产纯函数把这次折叠预演一遍 —— 夹具缩水时在这里报出真实数字。
          type: "expectFoldFixtureReallyFoldable",
          run: async ctx => {
            const sessionId = getActiveSessionId()
            const pre = preCompactionSnapshot
            if (!pre || pre.trial !== ctx.trial || pre.sessionId !== sessionId) {
              throw new Error("压缩前的快照缺失（上一条断言未完成），折叠前提无从判定")
            }

            await harnessSlots.flushAudit(sessionId)
            const slot = harnessSlots.peek(sessionId)
            if (slot && !(await slot.waitForIdle())) throw new Error("槽没有空闲：折叠前仍有在飞操作")
            await flushSessionFrameWrites(BACKGROUND_CONTEXT)

            const metadata = (await listPiSessionMetadata()).find(item => item.id === sessionId)
            if (!metadata) throw new Error(`会话不在仓库列表里: ${sessionId}`)
            const onDisk = await readOnDisk(metadata.path)
            const beforeFold = await captureSession(sessionId)

            // 前提预演（纯函数、不碰盘）：这份文件真的会折叠，且真的越过闸门 1 与闸门 2。
            const plan = prepareFold(readFoldLog(onDisk.text))
            if (plan.kind !== "fold") throw new Error(`折叠前提不成立：夹具不可折叠（skip: ${plan.reason}）｜${sizing()}`)
            if (plan.bytesBefore !== onDisk.bytes) {
              throw new Error(`盘上字节 ${onDisk.bytes} 与折叠预演 ${plan.bytesBefore} 不一致（文件尾部可能不完整）`)
            }
            if (plan.bytesBefore <= FOLD_POLICY.minFileBytes) {
              throw new Error(`夹具未过闸门 1：${plan.bytesBefore} B ≤ minFileBytes=${FOLD_POLICY.minFileBytes} B｜${sizing()}`)
            }
            const reclaimed = plan.bytesBefore - plan.bytesAfter
            if (reclaimed < FOLD_POLICY.minReclaimBytes || reclaimed < plan.bytesBefore * FOLD_POLICY.minReclaimRatio) {
              throw new Error(`夹具未过闸门 2：可回收 ${reclaimed} B（minReclaimBytes=${FOLD_POLICY.minReclaimBytes}、`
                + `比例 ${(reclaimed / plan.bytesBefore).toFixed(3)} vs minReclaimRatio=${FOLD_POLICY.minReclaimRatio}）｜${sizing()}`)
            }
            // 可回收量必须来自长回复的流式帧（死 key 的整行 append）：文件够大但一行可丢都没有时是假夹具；
            // 帧数下界由切片上限反推 —— 真实的流式路径必然给出这么多帧，掉了就说明夹具没走生产链路。
            const frameFloor = (TURNS - 1) * Math.floor(REPLY_CHARS / FRAME_CHARS_MAX)
            if (plan.droppedWrites < frameFloor) {
              throw new Error(`可回收写入 ${plan.droppedWrites} < 帧数下界 ${frameFloor}：可回收量不是来自长回复的流式帧`
                + `（droppedLines=${plan.droppedLines}）｜${sizing()}`)
            }

            // 压缩侧的前提：折叠前的条目里恰好一条 compaction（本次手动压缩），
            // 且压缩前已有的条目一条不少 —— 少的那部分在 check 3 之前就已经丢了，不能带进折叠比对。
            if (beforeFold.compactionIds.length !== 1) {
              throw new Error(`折叠前快照里的 compaction 条目应为 1 条，实际 ${beforeFold.compactionIds.length} 条`)
            }
            for (const [id, json] of pre.entries) {
              if (!beforeFold.entries.has(id)) throw new Error(`压缩丢掉了压缩前已有的条目 ${entryBrief(id, json)}`)
            }

            fixture = {
              trial: ctx.trial,
              sessionId,
              metadata,
              preCompaction: pre.entries,
              beforeFold,
              bytesOnDisk: onDisk.bytes,
            }
          },
        },
        {
          // 折叠 + 逐字比对。折叠走生产入口 `repo.foldSession(metadata)`（同一函数由 T5.04 的关闭路径调用）。
          type: "expectFoldKeepsEntriesByteIdentical",
          run: async ctx => {
            const current = fixture
            if (!current || current.trial !== ctx.trial) {
              throw new Error("折叠前的快照缺失（前一条断言未完成），本条无法判定")
            }
            const sessionId = current.sessionId

            // 折叠的执行契约要求该文件没有写入者：先关原始句柄（幂等），再冲帧缓冲。
            const session = await acquirePiSession(sessionId)
            await session.close(BACKGROUND_CONTEXT)
            await flushSessionFrameWrites(BACKGROUND_CONTEXT)

            const repo = await getPiSessionRepo()
            const fold = await repo.foldSession(current.metadata, BACKGROUND_CONTEXT)
            if (fold.kind !== "folded") {
              throw new Error(`夹具未真正折叠（foldSession 返回 ${fold.kind}: ${fold.reason}）：`
                + "没有折叠就没有「折叠前后」可言，三条逐字断言会退化成空断言"
                + `（折叠前 ${current.bytesOnDisk} B vs minFileBytes=${FOLD_POLICY.minFileBytes} B、minReclaimBytes=${FOLD_POLICY.minReclaimBytes} B）｜${sizing()}`)
            }
            // 折的必须是本会话文件：折叠报告的字节账目与盘上快照对上，下面的比对才是关于这份文件的。
            if (fold.path !== current.metadata.path) throw new Error(`折叠的不是本会话文件: ${fold.path}`)
            const onDiskAfter = await readOnDisk(current.metadata.path)
            if (fold.bytesBefore !== current.bytesOnDisk) {
              throw new Error(`折叠报告的折叠前字节 ${fold.bytesBefore} ≠ 折叠前盘上快照 ${current.bytesOnDisk}`)
            }
            if (fold.bytesAfter !== onDiskAfter.bytes) {
              throw new Error(`折叠报告的折叠后字节 ${fold.bytesAfter} ≠ 折叠后盘上 ${onDiskAfter.bytes}`)
            }
            if (onDiskAfter.text === "") throw new Error("折叠后文件为空")

            // 句柄缓存释放后由会话层重新 open：下面读到的条目来自折叠后的文件。
            await releasePiSession(sessionId)
            const snapshot = await captureSession(sessionId)

            // X-2 ①：压缩前已有的全部条目仍在且逐字不变（id 对齐，丢失与改写都在这里显形）。
            for (const [id, json] of current.preCompaction) {
              const now = snapshot.entries.get(id)
              if (now === undefined) throw new Error(`折叠丢掉了压缩前已有的条目 ${entryBrief(id, json)}`)
              if (now !== json) {
                throw new Error(`折叠改写了压缩前已有的条目 ${entryBrief(id, json)}：${divergence(json, now)}`)
              }
            }
            // X-2 ②：折叠前已有的全部条目（含 compaction 条目）仍在且逐字不变。
            for (const [id, json] of current.beforeFold.entries) {
              const now = snapshot.entries.get(id)
              if (now === undefined) throw new Error(`折叠丢掉了折叠前已有的条目 ${entryBrief(id, json)}`)
              if (now !== json) {
                throw new Error(`折叠改写了折叠前已有的条目 ${entryBrief(id, json)}：${divergence(json, now)}`)
              }
            }
            if (current.beforeFold.compactionIds.length === 0) {
              throw new Error("折叠前的快照里没有 compaction 条目：X-2 的组合断言退化成了空断言")
            }
            for (const id of current.beforeFold.compactionIds) {
              if (!snapshot.entries.has(id)) throw new Error(`折叠丢掉了 compaction 条目: ${id}`)
            }
            // 折叠只删不增：条目集合不得变大（多出来的条目说明折叠之外还有写入，比对会失真）。
            if (snapshot.entries.size > current.beforeFold.entries.size) {
              throw new Error(`折叠后条目变多了：${current.beforeFold.entries.size} → ${snapshot.entries.size}`)
            }
            // X-2 ③：聊天视图的用户/助手正文序列逐字不变。
            if (JSON.stringify(snapshot.users) !== JSON.stringify(current.beforeFold.users)) {
              throw new Error(`折叠改动了聊天视图的用户正文序列：${current.beforeFold.users.length} → ${snapshot.users.length} 条`
                + `（长度 ${JSON.stringify(current.beforeFold.users.map(text => text.length))}`
                + ` → ${JSON.stringify(snapshot.users.map(text => text.length))}）`)
            }
            if (JSON.stringify(snapshot.assistants) !== JSON.stringify(current.beforeFold.assistants)) {
              throw new Error(`折叠改动了聊天视图的助手正文序列：${current.beforeFold.assistants.length} → ${snapshot.assistants.length} 条`
                + `（长度 ${JSON.stringify(current.beforeFold.assistants.map(text => text.length))}`
                + ` → ${JSON.stringify(snapshot.assistants.map(text => text.length))}）`)
            }
            // 场景用完即弃：临时快照不留给下一条断言/trial（会话本身由 standardSetup 隔离）。
            fixture = undefined
            preCompactionSnapshot = undefined
          },
        },
      ],
    },
  ],
}

export default 折叠完整性
