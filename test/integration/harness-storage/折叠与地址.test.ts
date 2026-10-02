// ==========================================
// 折叠与地址交界（T5.09，源项 X-1）—— 从 test/e2e/scenes/harness-storage/折叠与地址.scene.ts 迁到 L3（W2）
//
// 为什么折叠不该改地址：折叠只删「确定可丢的**整行**」（`list/append` 与 `value/set`，且必须排在
// 该 key 最后一次 delete 之前），保留行是**原文子串** —— `prepareFold` 从不重新序列化任何保留行
// （`session-fold.ts` 的 S-2），也不新增写入、不重编号（S-3）。于是 `entry` 行的 id / seq / parentId
// 逐字不变 ⇒「会话内可解析的工具结果条目 id 全集」这个集合在折叠前后是同一个。
// 展示地址是这个集合的纯函数（`shortenAddresses`：先排序，再取与相邻 id 的最长公共前缀 + 1，
// 不读 seq / 行号 / 顺序），集合不变则两次输出逐字相同 ⇒ 折叠前发给模型的地址，在折叠后仍然
// 唯一命中同一条工具结果。
//
// 本场景证的是**折叠与地址的交界**，不证别的（折叠正确性归 hs-07 `harness-session-log-fold`，
// 中断安全归 hs-08 的 `harness-session-log-fold-crash`）。这里对折叠的全部要求只有一条：
// **它真的发生了**（`foldSession` 返回 `folded`）；没折叠就说明下面的断言在比较「同一份没变过的
// 数据」，会退化成空断言，因此夹具直接判失败而不静默通过。
//
// 迁移时的审视修正（对应契约「审计线索」的复核结论）：
//   · :316（D4）原 check 2 断言 `shortenAddresses(before)` 与 `shortenAddresses(after)` 逐字相同 ——
//     但 check 1 已经断言两侧 messageIds 与逐条 entry 摘要逐字相同，`shortenAddresses` 又是纯函数，
//     这条等式因此**不可能独立失败**（两侧过同一纯函数，恒真）。迁移后删除等式，保留同一条 check
//     里真正有区分力的部分：地址目录与 id 全集一一对应、地址是 id 前缀、不短于下界。
//     「折叠前发出的地址在折叠后仍唯一命中」由 check 3 的解析断言承担。
//
// 不使用任何定时器 API：夹具的每一步都由显式 await 推进。
// L3：IPC 由 test/host/node-ipc.ts 顶替（真实 Rust 命令的 Node 等价实现）；仓库/折叠路径同一份产品代码。
// ==========================================

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core"
import type { AgentMessage, EntryQuery, FileError, JsonlSessionMetadata, Result, Session } from "@earendil-works/pi-agent-core"
import { pendingAssistantFrames } from "@earendil-works/pi-agent-core/harness/session"
import { contentText } from "@earendil-works/pi-ai"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { FOLD_POLICY, createPiSessionRepo, flushSessionFrameWrites } from "@/services/engine/harness"
import type { FoldOutcome, PiSessionRepo } from "@/services/engine/harness"
import { MIN_ADDRESS_PREFIX, isUniqueAddressRef, resolveAddressRef, shortenAddresses } from "@/services/context"
import { stableSerialize } from "@/services/engine/runtime"
import { PI_LANE } from "@/services/session/repo"
import { SESSION_TRANSCRIPT_TOOL } from "@/services/tool"
import { initPaths, runtimePath } from "@/services/paths"
import { TauriExecutionEnv } from "@/services/tool/pi/tauri-execution-env"

type JsonlSession = Session<JsonlSessionMetadata>

/**
 * 取 id 全集用的查询：与 `harness-slot.ts` 的 `toolResultEntryIds()` 同一形状（只看 message 条目），
 * 外加显式 `order: "asc"` —— 折叠前后要用同一个查询取两次，「有序」是断言的一部分。
 */
const MESSAGE_QUERY: EntryQuery = { type: "message", order: "asc" }

/** 工具结果的消息角色（取快照时的过滤与断言里的判定共用这一个定义点）。 */
const TOOL_RESULT_ROLE = "toolResult"

/** 工具结果条目条数：≥2 才能让「前缀唯一性」有内容（只有一条时任何前缀都唯一）。 */
const TOOL_RESULT_COUNT = 4

/**
 * 帧的体积：夹具总体积必须**明显**超过折叠闸门 1（`FOLD_POLICY.minFileBytes`），否则
 * `foldSession` 返回 skipped、夹具判失败。条数由闸门**推导**而不是写死：`FOLD_POLICY` 是
 * 可调旋钮，写死条数会在它上调后静默不过闸门。
 */
const FRAME_DELTA_CHARS = 8 * 1024
const FRAME_COUNT = Math.ceil((FOLD_POLICY.minFileBytes * 1.25) / FRAME_DELTA_CHARS)
const FRAME_OPERATION = "op-fold-address"
const FRAME_RESPONSE = "resp-fold-address"

const TOOL_RESULT_PREFIX = "折叠前写入的工具结果"

let dataRoot = ""

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), "deskpet-harness-foldaddr-"))
  setTestDataRoot(dataRoot)
  await initPaths()
})

afterAll(() => {
  rmSync(dataRoot, { recursive: true, force: true })
})

/** 解包 Result（夹具解码器，不是断言）：失败时先经 expect 记一条带错误码的失败，再中止本用例。 */
function expectOk<T>(result: Result<T, FileError>, label: string): T {
  expect(result.ok, `${label}: ${result.ok ? "" : `${result.error.code}: ${result.error.message}`}`).toBe(true)
  if (!result.ok) throw new Error(`${label}: ${result.error.message}`)
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
 * 合成的工具结果条目：`ToolResultMessage` 的必填字段齐全（真实产物由工具适配器写入）。
 * 不跑生产回合造它 —— 那会把场景的结论绑到 provider 与模型的抖动上。
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

/** 一次快照里每条 message 条目的回读判定与正文。 */
interface Readback {
  role: string
  text: string
}

/** 会话在某一时刻对「条目与地址」的完整视图；折叠前后各取一次。 */
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
    expect(entry, `按 id 取不回条目: ${id}`).toBeDefined()
    entryDigests.set(id, stableSerialize(entry))
    if (entry!.type !== "message" || entry!.message.role !== TOOL_RESULT_ROLE) continue
    toolResultIds.push(id)
    readbacks.set(id, { role: entry!.message.role, text: contentText(entry!.message.content) })
  }
  return { messageIds, toolResultIds, entryDigests, readbacks }
}

interface FoldAddressFixture {
  metadata: JsonlSessionMetadata
  before: AddressSnapshot
  after: AddressSnapshot
  /** 只可能是 folded：夹具在 skipped 时直接判失败（没有折叠就没有「折叠前后」）。 */
  fold: Extract<FoldOutcome, { kind: "folded" }>
  repo: PiSessionRepo
  plain: TauriExecutionEnv
  root: string
}

/**
 * 夹具：临时会话根上的真会话，写满可回收的帧后折叠一次，折叠前后各取一份快照。
 *
 * 顺序即前提，不可换：写条目与帧 → 取「折叠前」快照 → `close`（句柄关闭，盘上再没有写入者）
 * → `foldSession`（唯一的折叠点）→ `open`（此刻文件已低于闸门 1，兜底折叠是空操作）
 * → 取「折叠后」快照。中间任何一次多余的 `open` 都会让兜底折叠抢先发生、把「折叠前」抹掉。
 */
async function buildFoldAddressFixture(): Promise<FoldAddressFixture> {
  const context = BACKGROUND_CONTEXT
  const plain = new TauriExecutionEnv(await runtimePath("data"))
  const root = expectOk(await plain.createTempDir("deskpet-live-fold-address-", context), "createTempDir")
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
    expect(
      fold.kind,
      `夹具未真正折叠（foldSession 返回 ${fold.kind === "skipped" ? fold.reason : "?"}）；没有折叠就没有「折叠前后」可言，地址断言会退化成空断言`,
    ).toBe("folded")
    if (fold.kind !== "folded") throw new Error("夹具未真正折叠")

    const reopened = await repo.open(metadata, context)
    let after: AddressSnapshot
    try {
      after = await snapshot(reopened)
    } finally {
      await reopened.close(context)
    }

    return { metadata, before, after, fold, repo, plain, root }
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

describe("折叠与地址", () => {
  it("折叠只删 list/value 行，entry 行逐字不动 ⇒ entryId 与由它派生的回读地址逐字不变；折叠后条目仍可在会话作用域内按 id 取回 [harness-session-log-fold-address]", async () => {
    const current = await buildFoldAddressFixture()
    try {
      // ── 第一层：id 与条目内容（独立于地址算法本身）──
      {
        // 前置：这一轮折叠必须有实际回收量，否则下面比较的是同一份没变过的数据。
        expect(current.fold.droppedLines, `折叠未删掉任何整行: ${JSON.stringify(current.fold)}`).toBeGreaterThanOrEqual(1)

        expect(
          current.after.messageIds.length,
          `折叠改变了条目条数：折叠前 ${current.before.messageIds.length} 条，折叠后 ${current.after.messageIds.length} 条`,
        ).toBe(current.before.messageIds.length)
        expect(
          JSON.stringify(current.after.messageIds),
          `折叠改变了条目 id 有序列表：折叠前 ${JSON.stringify(current.before.messageIds)}，折叠后 ${JSON.stringify(current.after.messageIds)}`,
        ).toBe(JSON.stringify(current.before.messageIds))

        // 逐条按 id 取回，条目内容逐字相同（id 相同但内容被重写也是失败）。
        for (const id of current.before.messageIds) {
          const digestBefore = current.before.entryDigests.get(id)
          const digestAfter = current.after.entryDigests.get(id)
          expect(digestBefore !== undefined && digestAfter !== undefined, `折叠后缺条目: ${id}`).toBe(true)
          expect(digestAfter, `折叠改写了条目内容: ${id}\n折叠前 ${digestBefore}\n折叠后 ${digestAfter}`).toBe(digestBefore)
        }

        // 地址全集是这份 id 列表的真子集：role 过滤在折叠两侧都还在（否则「地址全集」会静默变宽/变窄）。
        expect(
          [current.before.toolResultIds.length, current.after.toolResultIds.length],
          `工具结果条目数不符，期望两侧都是 ${TOOL_RESULT_COUNT} 条`,
        ).toEqual([TOOL_RESULT_COUNT, TOOL_RESULT_COUNT])
        for (const id of current.before.toolResultIds) {
          expect(current.after.messageIds.includes(id), `工具结果条目不在折叠后的 message 条目里: ${id}`).toBe(true)
        }
      }

      // ── 第二层：地址目录契约（原 check 2）──
      // 原 :316 的「两次输出逐字相同」已删除（D4）：check 1 已断言两侧 id 全集逐字相同、
      // shortenAddresses 又是纯函数，这条等式不可能独立失败。保留的是能独立失败的部分。
      {
        const refsBefore = shortenAddresses(current.before.toolResultIds)
        expect(refsBefore.size, `地址目录条数 ${refsBefore.size} ≠ 地址全集条数 ${current.before.toolResultIds.length}`).toBe(
          current.before.toolResultIds.length,
        )
        for (const [id, ref] of refsBefore) {
          expect(id.startsWith(ref), `地址不是 id 的前缀: ${ref} ← ${id}`).toBe(true)
          expect(ref.length >= MIN_ADDRESS_PREFIX, `地址短于前缀下界 ${MIN_ADDRESS_PREFIX}: ${ref}`).toBe(true)
        }
      }

      // ── 第三层：折叠**前**发出去的地址，在折叠**后**的 id 全集里仍然唯一命中同一条 ──
      {
        const issued = shortenAddresses(current.before.toolResultIds)
        expect(issued.size, "夹具没有工具结果条目，地址断言恒真").toBeGreaterThan(0)

        for (const id of current.before.toolResultIds) {
          const ref = issued.get(id)
          expect(ref, `地址目录缺条目: ${id}`).toBeDefined()
          const resolution = resolveAddressRef(ref!, current.after.toolResultIds)
          expect(
            resolution.kind,
            `折叠后前缀不再命中或变成歧义（折叠不得让任何地址失效）: ${ref} → ${JSON.stringify(resolution)}`,
          ).toBe("unique")
          expect(resolution.kind === "unique" ? resolution.id : undefined, `折叠后前缀命中了别的条目: ${ref}`).toBe(id)
          expect(isUniqueAddressRef(ref!, id, current.after.toolResultIds), `折叠后前缀在 id 全集里不再唯一: ${ref} → ${id}`).toBe(true)
        }

        // 反向：完整 id 永远精确命中（与折叠无关的另一半语义，用来固定 resolution 的词表）。
        for (const id of current.after.toolResultIds) {
          const resolution = resolveAddressRef(id, current.after.toolResultIds)
          expect(resolution, `完整 id 应精确命中: ${id}`).toEqual({ kind: "exact", id })
        }
      }

      // ── 第四层：回读链路的存储侧 —— 折叠后按 id 取回条目并读出正文，判定与正文逐字相同 ──
      {
        const texts = new Set<string>()
        for (const id of current.before.toolResultIds) {
          const readBefore = current.before.readbacks.get(id)
          const readAfter = current.after.readbacks.get(id)
          expect(readBefore, `折叠前的回读快照缺条目: ${id}`).toBeDefined()
          expect(readAfter, `折叠后按 id 取不回工具结果: ${id}`).toBeDefined()
          expect(
            [readBefore!.role, readAfter!.role],
            `回读判定失败（应命中 ${TOOL_RESULT_ROLE}）: ${id} → 折叠前 ${readBefore!.role}、折叠后 ${readAfter!.role}`,
          ).toEqual([TOOL_RESULT_ROLE, TOOL_RESULT_ROLE])
          expect(readAfter!.text, `折叠改写了工具结果正文: ${id}`).toBe(readBefore!.text)
          expect(readAfter!.text.length, `折叠后取回的正文为空: ${id}`).toBeGreaterThan(0)
          texts.add(readAfter!.text)
        }
        // 正文两两不同 ⇒ 上面的逐条比对确实取回了「各自那一条」，而不是同一个结果被重复读出。
        expect(texts.size, `回读正文有重复（地址可能指向了同一条）`).toBe(current.after.toolResultIds.length)
      }
    } finally {
      await disposeFixture(current)
    }
  })
})
