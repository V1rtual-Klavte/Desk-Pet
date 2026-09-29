// ==========================================
// 折叠与地址交界场景（T5.09，源项 X-1）—— 折叠前后地址逐字相同
//
// 为什么折叠不该改地址：折叠只删「确定可丢的**整行**」（`list/append` 与 `value/set`，且必须排在
// 该 key 最后一次 delete 之前），保留行是**原文子串** —— `prepareFold` 从不重新序列化任何保留行
// （`session-fold.ts` 的 S-2），也不新增写入、不重编号（S-3）。于是 `entry` 行的 id / seq / parentId
// 逐字不变 ⇒「会话内可解析的工具结果条目 id 全集」这个集合在折叠前后是同一个。
// 展示地址是这个集合的纯函数（`shortenAddresses`：先排序，再取与相邻 id 的最长公共前缀 + 1，
// 不读 seq / 行号 / 顺序），集合不变则两次输出逐字相同（含 Map 键序）⇒ 折叠前发给模型的地址，
// 在折叠后仍然唯一命中同一条工具结果。
//
// 本场景证的是**折叠与地址的交界**，不证别的：
//   · 不证折叠正确性本身（只删不增、保留行逐字不变、entryId/seq 不变、摘要重放一致、版本不匹配跳过）
//     —— 那是 hs-07 的 `harness-session-log-fold`；
//   · 不证折叠中断安全（写到一半失败时原文件完好）—— 那是 hs-08 的另一条 `harness-session-log-fold-crash`。
//   这里对折叠的全部要求只有一条：**它真的发生了**（`foldSession` 返回 `folded`）；没折叠就说明
//   下面的断言在比较「同一份没变过的数据」，会退化成空断言，因此夹具直接判失败而不静默通过。
//
// 折叠走生产入口 `repo.foldSession(metadata)`（= `foldSessionFile`：读一次 → 判定 → 摘要校验 →
//   同目录临时文件 → rename 覆盖）。open 前的兜底折叠（`session-repo.ts` 的 `maybeFoldBeforeOpen`）
//   不会抢先发生：折叠前的每一次读取都走**同一个已打开的句柄**，中间不重新 open —— 打开一个超过
//   `FOLD_POLICY.minFileBytes` 的文件本身就会触发折叠（那是生产行为，但会让「折叠前」无从测量）。
//
// 夹具形态（与 hs-07 同源）：真会话 + 真提交造出的**条目**（真 id / seq / parentId）+
//   走真实 commit 路径写入的**帧**（`pi.pending.assistant_frame` 的 `list/append`，随后一条
//   `list/delete` 让这些整行全部可回收）。工具结果条目是合成的（不跑生产回合，避免 provider 与
//   模型的不确定性）；它的形状是否被上游接受，由「close 之后重新 open 成功且按 id 取回正文」
//   来证明 —— `applyValidated` 或读取路径不认，场景会红，不会静默通过。
//
// 不使用任何定时器 API：夹具的每一步都由显式 await 推进（体积与回收量由帧的字节数决定，
//   与时间无关）。
// `entry: "unit"`：只走真实 Rust IPC 与真实会话提交路径，不跑模型。
// ==========================================

import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core"
import type { AgentMessage, EntryQuery, FileError, JsonlSessionMetadata, Result, Session } from "@earendil-works/pi-agent-core"
import { pendingAssistantFrames } from "@earendil-works/pi-agent-core/harness/session"
import { contentText } from "@earendil-works/pi-ai"
import { FOLD_POLICY, createPiSessionRepo, flushSessionFrameWrites } from "@/services/engine/pi"
import type { FoldOutcome, PiSessionRepo } from "@/services/engine/pi"
import { MIN_ADDRESS_PREFIX, isUniqueAddressRef, resolveAddressRef, shortenAddresses } from "@/services/context"
import { stableSerialize } from "@/services/engine/runtime"
import { PI_LANE } from "@/services/session/repo"
import { SESSION_TRANSCRIPT_TOOL } from "@/services/tool"
import { runtimePath } from "@/services/paths"
import { TauriExecutionEnv } from "@/services/tool/pi/tauri-execution-env"
import type { SceneDef } from "../../../e2e/types"

type JsonlSession = Session<JsonlSessionMetadata>

/**
 * 取 id 全集用的查询：与 `harness-slot.ts` 的 `toolResultEntryIds()` 同一形状（只看 message 条目），
 * 外加显式 `order: "asc"` —— 折叠前后要用同一个查询取两次，「有序」是断言的一部分。
 */
const MESSAGE_QUERY: EntryQuery = { type: "message", order: "asc" }

/**
 * 工具结果的消息角色。同一个字面量在「取快照时的过滤」与「断言里的判定」两处出现，
 * 只留这一个定义点（与 `harness-slot.ts` 的 `readToolResultText` 同一判定）。
 */
const TOOL_RESULT_ROLE = "toolResult"

/** 工具结果条目条数：≥2 才能让「前缀唯一性」有内容（只有一条时任何前缀都唯一）。 */
const TOOL_RESULT_COUNT = 4

/**
 * 帧的体积：夹具总体积必须**明显**超过折叠闸门 1（`FOLD_POLICY.minFileBytes`），否则
 * `foldSession` 返回 skipped、夹具判失败（见下面的构造）。
 *
 * 条数由闸门**推导**而不是写死：一条帧行 ≈ `FRAME_DELTA_CHARS` + 固定结构 ≈ +2%，所以按
 * 「帧总量 = 闸门 1 × 1.25 / 每条字节量」取条数，实际总量必然过闸门；可回收量因此 ≈ 整个文件，
 * 闸门 2（绝对值与比例）一并满足。`FOLD_POLICY` 是可调旋钮，写死条数会在它上调后静默不过闸门。
 */
const FRAME_DELTA_CHARS = 8 * 1024
const FRAME_COUNT = Math.ceil((FOLD_POLICY.minFileBytes * 1.25) / FRAME_DELTA_CHARS)
const FRAME_OPERATION = "op-fold-address"
const FRAME_RESPONSE = "resp-fold-address"

const TOOL_RESULT_PREFIX = "折叠前写入的工具结果"

function fileOk<T>(result: Result<T, FileError>): T {
  if (!result.ok) throw new Error(`期望成功，实际失败: ${result.error.message}`)
  return result.value
}

/** 一条非工具结果的 message 条目：证明地址全集是按 role 过滤出来的，不是「全部 message 条目」。 */
function userMessage(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() }
}

/** 合成工具结果条目的正文：逐条可区分，回读时能判出「取回的是不是这一条」。 */
function toolResultText(index: number): string {
  return `${TOOL_RESULT_PREFIX} #${index}：` + `内容-${index}|`.repeat(8)
}

/**
 * 合成的工具结果条目：`ToolResultMessage` 的必填字段齐全（真实产物由工具适配器写入，
 * 形状见 `tools/index.ts` 的 toolResult 构造）。不跑生产回合造它 —— 那会把 scene 的结论
 * 绑到 provider 与模型的抖动上。
 */
function toolResultMessage(index: number): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: `call-fold-address-${index}`,
    toolName: SESSION_TRANSCRIPT_TOOL,
    content: [{ type: "text", text: toolResultText(index) }],
    isError: false,
    timestamp: Date.now(),
  }
}

/** 一条流式帧的元素：形状与 `progress.js` 推入的 thinking_delta 相同，只有 delta 定长可判。 */
function thinkingFrame(index: number): { type: "thinking_delta"; contentIndex: number; delta: string } {
  const prefix = `帧-${index}-`
  return { type: "thinking_delta", contentIndex: 0, delta: `${prefix}${"x".repeat(FRAME_DELTA_CHARS - prefix.length)}` }
}

/** 一次快照里每条 message 条目的回读判定与正文（与 `harness-slot.ts` 的 `readToolResultText` 同源）。 */
interface Readback {
  role: string
  text: string
}

/** 会话在某一时刻对「条目与地址」的完整视图；折叠前后各取一次，两份必须逐字相等。 */
interface AddressSnapshot {
  /** 全部 message 条目的 id，按 seq 升序（折叠前后必须逐字相同）。 */
  messageIds: string[]
  /** 其中可解析为工具结果的 id —— 地址全集的唯一来源。 */
  toolResultIds: string[]
  /** id → `stableSerialize(entry)`：条目内容逐字相等的判据。 */
  entryDigests: Map<string, string>
  /** 工具结果 id → 回读判定与正文。 */
  readbacks: Map<string, Readback>
}

/**
 * 取一次快照：先把 id 有序列表取出来，再**逐条按 id 取回**条目（走 `getEntry`，与回读链路的
 * 存储侧同一个入口），因此这份快照同时是「id 集合」「条目内容」「回读正文」三者的真相源。
 */
async function snapshot(session: JsonlSession): Promise<AddressSnapshot> {
  const entries = await session.findEntries(MESSAGE_QUERY, BACKGROUND_CONTEXT)
  const messageIds = entries.map(entry => entry.id)
  const toolResultIds: string[] = []
  const entryDigests = new Map<string, string>()
  const readbacks = new Map<string, Readback>()
  for (const id of messageIds) {
    const entry = await session.getEntry(id, BACKGROUND_CONTEXT)
    if (entry === undefined) throw new Error(`按 id 取不回条目: ${id}`)
    entryDigests.set(id, stableSerialize(entry))
    if (entry.type !== "message" || entry.message.role !== TOOL_RESULT_ROLE) continue
    toolResultIds.push(id)
    readbacks.set(id, { role: entry.message.role, text: contentText(entry.message.content) })
  }
  return { messageIds, toolResultIds, entryDigests, readbacks }
}

interface FoldAddressFixture {
  /** 夹具所属 trial：模块级变量跨 trial 存活（同页复用），trial 变了必须重建。 */
  trial: number
  metadata: JsonlSessionMetadata
  before: AddressSnapshot
  after: AddressSnapshot
  /** 只可能是 folded：夹具在 skipped 时直接判失败（没有折叠就没有「折叠前后」）。 */
  fold: Extract<FoldOutcome, { kind: "folded" }>
  repo: PiSessionRepo
  plain: TauriExecutionEnv
  root: string
}

let fixture: FoldAddressFixture | undefined

/**
 * 夹具：临时会话根上的真会话，写满可回收的帧后折叠一次，折叠前后各取一份快照。
 *
 * 顺序即前提，不可换：写条目与帧 → 取「折叠前」快照 → `close`（句柄关闭，盘上再没有写入者）
 * → `foldSession`（唯一的折叠点）→ `open`（此刻文件已低于闸门 1，兜底折叠是空操作）
 * → 取「折叠后」快照。中间任何一次多余的 `open` 都会让兜底折叠抢先发生、把「折叠前」抹掉。
 */
async function foldAddressFixture(trial: number): Promise<FoldAddressFixture> {
  if (fixture && fixture.trial === trial) return fixture
  if (fixture) {
    // 上一 trial 的夹具（例如上一轮中途超时被放弃）：先收尾再重建，不让临时根跨 trial 残留。
    const stale = fixture
    fixture = undefined
    await disposeFixture(stale)
  }

  const context = BACKGROUND_CONTEXT
  const plain = new TauriExecutionEnv(await runtimePath("data"))
  const root = fileOk(await plain.createTempDir("deskpet-live-fold-address-", context))
  // 生产默认形态：仓库自带帧写入缓冲装饰器（本场景不关它 —— 帧的真实写入路径就是它）。
  const repo = await createPiSessionRepo({ sessionsRoot: root, cwd: root })
  try {
    const session = await repo.create({ id: "fold-address" }, context)
    const metadata = session.metadata
    const branch = await session.branch(PI_LANE, context) ?? await session.createBranch(PI_LANE, null, context)

    // 真条目：走真实提交路径（真 id / seq / parentId，含 branchTip 的 value/set 行）。
    await branch.appendMessage(userMessage("折叠前后的展示地址应当逐字相同。"), context)
    for (let index = 0; index < TOOL_RESULT_COUNT; index++) {
      await branch.appendMessage(toolResultMessage(index), context)
    }

    // 帧：走真实 commit 路径写入（`appendList` → 帧缓冲装饰器 → appendFile），
    // 再用一条 `list/delete` 把同一个 key 的整行全部变成可回收 —— 这是折叠的主要回收来源。
    const frames = pendingAssistantFrames(FRAME_OPERATION, FRAME_RESPONSE)
    for (let index = 0; index < FRAME_COUNT; index++) {
      await session.appendList(frames, thinkingFrame(index), context)
    }
    await session.deleteList(frames, context)

    const before = await snapshot(session)
    // 折叠的前置条件：该文件没有写入者。`close` 不碰文件、也不折叠（折叠只发生在下面这一处）。
    await session.close(context)

    const fold = await repo.foldSession(metadata, context)
    if (fold.kind !== "folded") {
      const size = fileOk(await plain.fileInfo(metadata.path, context)).size
      throw new Error(
        `夹具未真正折叠（foldSession 返回 ${fold.kind}: ${fold.reason}），文件 ${size} B（闸门 ${FOLD_POLICY.minFileBytes} B）`
        + "；没有折叠就没有「折叠前后」可言，地址断言会退化成空断言",
      )
    }

    const reopened = await repo.open(metadata, context)
    let after: AddressSnapshot
    try {
      after = await snapshot(reopened)
    } finally {
      await reopened.close(context)
    }

    fixture = { trial, metadata, before, after, fold, repo, plain, root }
    return fixture
  } catch (error) {
    // 夹具建到一半失败：临时根与仓库句柄不留给后续检查（错误照原样抛给断言）。
    await flushSessionFrameWrites(context)
    await repo.close(context)
    await plain.remove(root, { recursive: true, force: true }, context)
    throw error
  }
}

async function disposeFixture(disposed: FoldAddressFixture): Promise<void> {
  const context = BACKGROUND_CONTEXT
  // 缓冲里仍可能留着本夹具的帧字节：先落地再删根，不让它在删除后落到别的路径上。
  await flushSessionFrameWrites(context)
  await disposed.repo.close(context)
  await disposed.plain.remove(disposed.root, { recursive: true, force: true }, context)
}

export const 折叠与地址: SceneDef = {
  meta: {
    caseId: "harness-session-log-fold-address",
    module: "harness-storage",
    contractId: "hs-08",
    description: "折叠只删 list/value 行，entry 行逐字不动 ⇒ entryId 与由它派生的回读地址逐字不变；折叠后条目仍可在会话作用域内按 id 取回",
    depth: "deep",
    suite: "regression",
    entry: "unit",
    tags: ["harness-storage", "session-fold", "address", "boundary"],
  },
  turns: [{
    index: 1,
    description: "折叠前后各取一份条目与地址快照，逐字比对 id、条目内容、地址与回读正文",
    userText: "校验会话日志折叠前后展示地址不变。",
    checks: [
      {
        // 第一层：id 与条目内容（独立于地址算法本身）。
        type: "expectEntryIdSetByteIdentical",
        run: async (ctx) => {
          const { before, after, fold } = await foldAddressFixture(ctx.trial)

          // 前置：这一轮折叠必须有实际回收量，否则下面比较的是同一份没变过的数据。
          if (fold.droppedLines < 1) throw new Error(`折叠未删掉任何整行: ${JSON.stringify(fold)}`)

          if (before.messageIds.length !== after.messageIds.length) {
            throw new Error(`折叠改变了条目条数：折叠前 ${before.messageIds.length} 条，折叠后 ${after.messageIds.length} 条`)
          }
          if (JSON.stringify(before.messageIds) !== JSON.stringify(after.messageIds)) {
            throw new Error(
              `折叠改变了条目 id 有序列表：折叠前 ${JSON.stringify(before.messageIds)}，折叠后 ${JSON.stringify(after.messageIds)}`,
            )
          }

          // 逐条按 id 取回，条目内容逐字相同（id 相同但内容被重写也是失败）。
          for (const id of before.messageIds) {
            const digestBefore = before.entryDigests.get(id)
            const digestAfter = after.entryDigests.get(id)
            if (digestBefore === undefined || digestAfter === undefined) throw new Error(`折叠后缺条目: ${id}`)
            if (digestBefore !== digestAfter) {
              throw new Error(`折叠改写了条目内容: ${id}\n折叠前 ${digestBefore}\n折叠后 ${digestAfter}`)
            }
          }

          // 地址全集是这份 id 列表的真子集：role 过滤在折叠两侧都还在（否则「地址全集」会静默变宽/变窄）。
          if (before.toolResultIds.length !== TOOL_RESULT_COUNT || after.toolResultIds.length !== TOOL_RESULT_COUNT) {
            throw new Error(
              `工具结果条目数不符：折叠前 ${before.toolResultIds.length} 条、折叠后 ${after.toolResultIds.length} 条，期望 ${TOOL_RESULT_COUNT} 条`,
            )
          }
          for (const id of before.toolResultIds) {
            if (!after.messageIds.includes(id)) throw new Error(`工具结果条目不在折叠后的 message 条目里: ${id}`)
          }
        },
      },
      {
        // 第二层：地址层（`shortenAddresses` 的两次输出全量逐字比对，含 Map 键序）。
        type: "expectShortenedAddressesUnchanged",
        run: async (ctx) => {
          const { before, after } = await foldAddressFixture(ctx.trial)
          const refsBefore = shortenAddresses(before.toolResultIds)
          const refsAfter = shortenAddresses(after.toolResultIds)

          // `[...map]` 展开成 [id, 前缀] 序列：键序（= 排序后的 id 顺序）与每个取值一起比。
          if (JSON.stringify([...refsBefore]) !== JSON.stringify([...refsAfter])) {
            throw new Error(
              `折叠改变了地址：折叠前 ${JSON.stringify([...refsBefore])}，折叠后 ${JSON.stringify([...refsAfter])}`,
            )
          }
          if (refsBefore.size !== before.toolResultIds.length) {
            throw new Error(`地址目录条数 ${refsBefore.size} ≠ 地址全集条数 ${before.toolResultIds.length}`)
          }
          for (const [id, ref] of refsBefore) {
            if (!id.startsWith(ref)) throw new Error(`地址不是 id 的前缀: ${ref} ← ${id}`)
            if (ref.length < MIN_ADDRESS_PREFIX) {
              throw new Error(`地址短于前缀下界 ${MIN_ADDRESS_PREFIX}: ${ref}`)
            }
          }
        },
      },
      {
        // 第三层：折叠**前**发出去的地址，在折叠**后**的 id 全集里仍然唯一命中同一条 ——
        // 「回读链路不受影响」的可判定形态，比只比字符串更强。
        type: "expectPrefixStillResolvesAfterFold",
        run: async (ctx) => {
          const { before, after } = await foldAddressFixture(ctx.trial)
          const issued = shortenAddresses(before.toolResultIds)
          if (issued.size === 0) throw new Error("夹具没有工具结果条目，地址断言恒真")

          for (const id of before.toolResultIds) {
            const ref = issued.get(id)
            if (ref === undefined) throw new Error(`地址目录缺条目: ${id}`)
            const resolution = resolveAddressRef(ref, after.toolResultIds)
            if (resolution.kind === "none") throw new Error(`折叠后前缀不再命中: ${ref}`)
            if (resolution.kind === "ambiguous") {
              throw new Error(`折叠后前缀变成歧义（折叠不得让任何地址失效）: ${ref} → ${JSON.stringify(resolution.matches)}`)
            }
            if (resolution.id !== id) throw new Error(`折叠后前缀命中了别的条目: ${ref} → ${resolution.id}，期望 ${id}`)
            if (!isUniqueAddressRef(ref, id, after.toolResultIds)) {
              throw new Error(`折叠后前缀在 id 全集里不再唯一: ${ref} → ${id}`)
            }
          }

          // 反向：完整 id 永远精确命中（与折叠无关的另一半语义，用来固定 resolution 的词表）。
          for (const id of after.toolResultIds) {
            const resolution = resolveAddressRef(id, after.toolResultIds)
            if (resolution.kind !== "exact" || resolution.id !== id) {
              throw new Error(`完整 id 应精确命中: ${id} → ${JSON.stringify(resolution)}`)
            }
          }
        },
      },
      {
        // 回读链路的存储侧：折叠后按 id 取回条目并读出正文，判定与正文都与折叠前逐字相同。
        // （生产入口的完整回读链路另有既有场景覆盖，本场景不重复。）
        type: "expectReadbackStillWorksAfterFold",
        run: async (ctx) => {
          const current = await foldAddressFixture(ctx.trial)
          try {
            const texts = new Set<string>()
            for (const id of current.before.toolResultIds) {
              const readBefore = current.before.readbacks.get(id)
              const readAfter = current.after.readbacks.get(id)
              if (readBefore === undefined) throw new Error(`折叠前的回读快照缺条目: ${id}`)
              if (readAfter === undefined) throw new Error(`折叠后按 id 取不回工具结果: ${id}`)
              if (readBefore.role !== TOOL_RESULT_ROLE || readAfter.role !== TOOL_RESULT_ROLE) {
                throw new Error(`回读判定失败（应命中 ${TOOL_RESULT_ROLE}）: ${id} → 折叠前 ${readBefore.role}、折叠后 ${readAfter.role}`)
              }
              if (readBefore.text !== readAfter.text) {
                throw new Error(`折叠改写了工具结果正文: ${id}\n折叠前 ${readBefore.text}\n折叠后 ${readAfter.text}`)
              }
              if (readAfter.text.length === 0) throw new Error(`折叠后取回的正文为空: ${id}`)
              texts.add(readAfter.text)
            }
            // 正文两两不同 ⇒ 上面的逐条比对确实取回了「各自那一条」，而不是同一个结果被重复读出。
            if (texts.size !== current.after.toolResultIds.length) {
              throw new Error(`回读正文有重复（地址可能指向了同一条）: ${texts.size} 种正文 / ${current.after.toolResultIds.length} 条结果`)
            }
          } finally {
            // 本场景的最后一条检查：夹具用完即弃（临时根不留到下一个场景）。
            fixture = undefined
            await disposeFixture(current)
          }
        },
      },
    ],
  }],
}

export default 折叠与地址
