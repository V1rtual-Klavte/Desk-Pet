// ==========================================
// 帧节流流式场景（T1.06）—— 真实流式回合里的帧落盘、entry 立即落盘与新仓库读回
//
// 补的空白（与 hs-05 的分工）：
//   hs-05（`test/integration/harness-storage/帧写缓冲.test.ts`，L3）证明**机制与调用次数** —— 它把可注入计数器的
//   `CountingEnv` 注入自建仓库，能断言「N 帧合并成 ≤ ⌈总字节 / 16 KiB⌉ + 1 次 appendFile」。
//   本场景证明**真实链路不回归**：生产单例仓库（`getPiSessionRepo()`）不传任何 options、
//   注入不进计数器，所以这里只证「帧没丢、顺序对、非帧 entry 提交后文件完备、另一个仓库
//   实例能读回」，**不**证调用次数 —— 次数结论只在 hs-05，别在本场景里再声称一次。
//
// 真实帧的写入路径（执行方案 §0.2 已核实）：
//   上游 `harness/runtime/progress.js` 每个流式 delta 一次 `lane.command`
//     → `{ kind: "commit", writes: [commitWrite(item)] }`
//     → `JsonlStorage.applyCommit`（`harness/session/jsonl/storage.js:172-182`）
//     → `fileSystem.appendFile`（`storage.js:178`，全仓唯一一处 appendFile）
//     → 本仓 `FrameBufferingFileSystem` 按「帧 append / 非帧」分流（`engine/harness/session-frame-buffer.ts`）。
//   单写事务落成「单个 JSON 对象 + 换行」，多写事务落成 JSON 数组（一条多写事务 = 一行）；
//   所以读原始文件一律「逐行 JSON.parse → 数组展开」，与 `scripts/session-frame-stats.mjs` 同口径。
//
// 为什么 entry: "production"：要证的是**经 `sendMessage()` 的生产链路**（预处理 → Harness lane
//   → 帧编码 → commit → 装饰器 → Rust IPC）。fake Provider 只替换模型响应，帧编码、commit、
//   缓冲与落盘全是真实实现。
//
// faux 的分片数只是**估算**：`splitStringByTokenSize`（`pi-ai/dist/providers/faux.js:151-161`）
//   按 `charSize = tokenSize * 4`、`tokenSize ∈ [3, 5]`（默认）切分 ⇒ 平均约 16 字符一个
//   `text_delta`；`LONG_TEXT` 约 4000 字符 ⇒ 约 250 帧。估算不当断言用：断言只按下限写，
//   失败信息里打印实测帧数。
//
// 帧只是**进度快照**，持久层是正文 entry：回合收尾时上游会把帧列表整条 list/delete 掉
//   （`harness/runtime/drive/terminal.js` 的 `operationCleanupWrites`；参考会话实测 9/9 组
//   都有这条 delete）。所以 check 1/2 读**原始文件字节**，check 3 证明这些字节在真实
//   repo 读回路径（replay → readList）上逐条可读，并在注释里写清列表删除这条语义。
//
// 断言不引入任何定时器/时间等待：触发全部来自真实链路（回合结束 ⇒ entry 提交先冲帧缓冲）。
// ==========================================

import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core"
import type { FileError, Result } from "@earendil-works/pi-agent-core"
import { pendingAssistantFrames } from "@earendil-works/pi-agent-core/harness/session"
import type { CommittedListAppendWrite, CommittedWrite } from "@earendil-works/pi-agent-core/harness/session"
import { initChat, sendMessage } from "@/services/agent/runner"
import { createPiSessionRepo } from "@/services/engine/harness"
import { acquirePiSession, getActiveSessionId, getPiSessionRepo } from "@/services/session"
import { runtimePath } from "@/services/paths"
import { TauriExecutionEnv } from "@/services/tool/pi/tauri-execution-env"
import { fakeText, installFakeProvider } from "../../../host/fake-provider"
import type { SceneDef } from "../../../e2e/types"

// ── 判别锚点（从上游公开 API 派生，不复制实现里的字面量）──

/**
 * 帧写的命名空间。上游定义点：`values.js` 的
 * `pendingAssistantFrames = (opId, respId) => list("pi.pending.assistant_frame", ...)`。
 * 这里**从公开 API 取**而不是抄一份字符串：上游改名时本场景跟着变，不会静默失配。
 */
const FRAME_NAMESPACE = pendingAssistantFrames("", "").namespace

/** 帧 key 的分隔符：key 形如 `${operationId}${sep}${responseEntryId}`，同样从公开 API 派生。 */
const FRAME_KEY_SEPARATOR = pendingAssistantFrames("a", "b").key.slice(1, -1)

// ── 场景文本 ──

/** 唯一哨兵（40 字符），放在正文末尾：「按序拼接后仍包含它」同时证明尾段没被丢弃。 */
const SENTINEL = "哨兵-STREAM-7F3A9C1E4B2D8E6F-THROTTLE-ENDS"

/** 填充段落（75 字符）；重复 53 次 + 哨兵 ≈ 4015 字符，且全文只出现一次哨兵。 */
const FILLER = "夜幕落下来的时候，屋里只剩下键盘的声音。我把手边的事一件件说给你听：先关掉多余的窗口，再把明天要用的文件归到同一个角落，然后是今天没说完的那半句话。 "

/** 长流式回复的正文（约 4000 字符 ⇒ 按平均 16 字符一个 delta 估算约 250 个 text_delta 帧）。 */
const LONG_TEXT = `${FILLER.repeat(53)}${SENTINEL}`

/**
 * 帧 append 数的**断言下限**（不是估算值、不是上限）：估算是 ≈250，取 100 留足余量，
 * 同时仍能挡住「流式帧根本没落盘」「只落了起止边界」这类回归。
 */
const MIN_STREAM_FRAMES = 100

/** 字节口径（与 Rust `content.len()` 一致）；本场景只在诊断信息里用它，不用 `String.length`。 */
const textEncoder = new TextEncoder()

function byteLength(text: string): number {
  return textEncoder.encode(text).byteLength
}

function fileOk<T>(result: Result<T, FileError>): T {
  if (!result.ok) throw new Error(`期望成功，实际失败: ${result.error.message}`)
  return result.value
}

// ── 原始会话文件的读取与展开 ──

interface SessionFileDump {
  /** 会话文件绝对路径（来自应用单例仓库的会话句柄 metadata）。 */
  path: string
  /** 文件全部行（含表头），按文件顺序、已去掉空行。 */
  lines: string[]
  /** 展开后的写事务（数组行展开成多条；与 `scripts/session-frame-stats.mjs` 同口径）。 */
  writes: CommittedWrite[]
}

/**
 * 用**未包装**的 `TauriExecutionEnv` 直读会话文件字节。
 *
 * 未包装 = 绕过 `FrameBufferingFileSystem` 的读前 flush（以及一切缓冲状态）—— 读到的必须
 * 是**已经落在盘上**的字节，这正是 T-2/T-3 要证的。路径取自应用单例仓库的会话句柄，
 * 不自己拼路径（会话布局只有一处定义）。
 */
async function dumpSessionFile(): Promise<SessionFileDump> {
  const sessionId = getActiveSessionId()
  if (!sessionId) throw new Error("没有活跃会话：production 场景必须经 sendMessage() 建会话")
  const session = await acquirePiSession(sessionId)
  const path = session.metadata.path
  const env = new TauriExecutionEnv(await runtimePath("data"))
  const content = fileOk(await env.readTextFile(path, BACKGROUND_CONTEXT))

  const lines = content.split("\n").filter(line => line !== "")
  if (lines.length === 0) throw new Error(`会话文件为空: ${path}`)
  const header = JSON.parse(lines[0]) as { kind?: unknown }
  if (header.kind !== "header") throw new Error(`会话文件首行不是表头: ${lines[0].slice(0, 80)}`)

  const writes: CommittedWrite[] = []
  for (const line of lines.slice(1)) {
    const parsed = JSON.parse(line) as CommittedWrite | CommittedWrite[]
    if (Array.isArray(parsed)) writes.push(...parsed)
    else writes.push(parsed)
  }
  return { path, lines, writes }
}

/** 帧 append 的判别：**恰好**是 `list/append` 且命名空间命中（不用子串判，见 §0.2 的口径收紧）。 */
function isFrameAppend(write: CommittedWrite): write is CommittedListAppendWrite {
  return write.kind === "list" && write.op === "append" && write.namespace === FRAME_NAMESPACE
}

/** 帧列表被 delete 的判别（终局事务里那条；check 3 用它定位字节快照的窗口）。 */
function isFrameDelete(write: CommittedWrite, key: string): boolean {
  return write.kind === "list" && write.op === "delete" && write.namespace === FRAME_NAMESPACE && write.key === key
}

/** 帧值的类型标签：内容来自磁盘 JSON，类型上不可信，非对象/缺 type 时如实报出来。 */
function frameTypeOf(write: CommittedListAppendWrite): string {
  const value: unknown = write.value
  if (typeof value !== "object" || value === null) return typeof value
  const type = (value as { type?: unknown }).type
  return typeof type === "string" ? type : "unknown"
}

/** `text_delta` 帧值的正文增量；其它帧类型返回 undefined，delta 形态不对则判失败。 */
function textDeltaOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const frame = value as { type?: unknown; delta?: unknown }
  if (frame.type !== "text_delta") return undefined
  if (typeof frame.delta !== "string") {
    throw new Error(`text_delta 帧的 delta 不是字符串: ${JSON.stringify(value).slice(0, 120)}`)
  }
  return frame.delta
}

/** 帧组：同一个 key 的帧 append。key = `${operationId}:${responseEntryId}`（上游 values.js 定义）。 */
interface FrameGroup {
  key: string
  operationId: string
  responseEntryId: string
  /** 该 key 的帧 append，按**文件顺序**（= 提交顺序），不在这里排序 —— 顺序本身要被断言。 */
  appends: CommittedListAppendWrite[]
}

function splitFrameKey(key: string): [string, string] {
  const at = key.indexOf(FRAME_KEY_SEPARATOR)
  if (at <= 0 || at + FRAME_KEY_SEPARATOR.length >= key.length) {
    throw new Error(`帧 key 不是「操作:响应条目」形状: ${key}`)
  }
  return [key.slice(0, at), key.slice(at + FRAME_KEY_SEPARATOR.length)]
}

function frameGroups(writes: readonly CommittedWrite[]): FrameGroup[] {
  const groups = new Map<string, FrameGroup>()
  for (const write of writes) {
    if (!isFrameAppend(write)) continue
    let group = groups.get(write.key)
    if (!group) {
      const [operationId, responseEntryId] = splitFrameKey(write.key)
      group = { key: write.key, operationId, responseEntryId, appends: [] }
      groups.set(write.key, group)
    }
    group.appends.push(write)
  }
  return [...groups.values()]
}

/**
 * 本场景要断言的那组帧 = 文件里**第一组**帧。
 *
 * setup 的长流式回合先跑（随后运行器还会为 turns[0] 发一条核对消息），所以文件里第一组帧
 * 就是长回合的；长度断言（≥ `MIN_STREAM_FRAMES`）会挡住「拿错组」的情形。
 */
async function readTurnFrames(): Promise<{ dump: SessionFileDump; group: FrameGroup }> {
  const dump = await dumpSessionFile()
  const group = frameGroups(dump.writes)[0]
  if (!group) {
    throw new Error(
      `会话文件里没有任何帧 append（${dump.path}，展开后 ${dump.writes.length} 条写）：` +
      `流式链路没有把帧交给 commit → 装饰器 → 落盘`,
    )
  }
  return { dump, group }
}

/**
 * 「终局事务之前」的字节快照（check 3 用）。
 *
 * 帧是进度快照：上游在回合收尾的多写事务里对帧列表 list/delete（`operationCleanupWrites`；
 * 参考会话实测 9/9 组都有，且与 assistant entry / usage / branch tip 同一条多写事务），
 * replay 之后列表整体消失 —— 所以「新仓库实例用 readList 读回帧」只能在**这条 delete 之前**
 * 的字节窗口上验证：拿真实文件的真实字节截一份快照喂给新仓库实例，证明这些帧行在真实的
 * `open() → replay → readList` 路径上逐条可读、内容与顺序与 check 1 一致。
 *
 * 找不到 delete 行（上游将来改为保留帧列表）时截取整个文件：两种语义下这条都成立，
 * 断言因此不依赖「上游一定会删」这个具体版本行为。
 */
function snapshotBeforeFrameDelete(dump: SessionFileDump, group: FrameGroup): string {
  let cut = -1
  for (let index = 1; index < dump.lines.length; index++) {
    const parsed = JSON.parse(dump.lines[index]) as CommittedWrite | CommittedWrite[]
    const writes = Array.isArray(parsed) ? parsed : [parsed]
    if (writes.some(write => isFrameDelete(write, group.key))) {
      cut = index
      break
    }
  }
  const kept = cut < 0 ? dump.lines : dump.lines.slice(0, cut)
  return `${kept.join("\n")}\n`
}

// ── 场景 ──

export const 帧节流流式: SceneDef = {
  meta: {
    caseId: "harness-frame-throttle-live",
    module: "harness-storage",
    contractId: "hs-06",
    description: "真实流式回合里帧落盘、entry 立即落盘与新仓库读回",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["harness-storage", "frame-throttle", "streaming"],
  },
  setup: async () => {
    // 两条响应对应两次 sendMessage：setup 的长流式回合 + 运行器为 turns[0] 发的核对回合。
    // faux 按 token 分片流式（默认无延迟），长正文因此产生约 250 个 text_delta 事件；
    // 每个事件一次真实 commit，帧由 `FrameBufferingFileSystem` 按 16 KiB 阈值合并落盘。
    installFakeProvider([fakeText(LONG_TEXT), fakeText("帧节流场景收尾")])
    await initChat()
    const turn = await sendMessage("跑一次长流式回复")
    // 回合失败时这里就失败：否则后面三条 check 只会报「没读到帧」，掩盖真正的根因。
    if (turn.failure) throw new Error(`长流式回合失败: ${turn.failure.kind}: ${turn.failure.message}`)
  },
  turns: [{
    index: 1,
    description: "回合收尾后回读原始会话文件：帧的内容与顺序、entry 提交时序、新仓库实例读回",
    userText: "核对本回合的帧落盘与读回。",
    checks: [
      {
        // T-2：真实链路上帧**没丢、顺序对**（内容用唯一哨兵证明，顺序用 seq 严格递增证明）。
        type: "expectStreamFramesArePersistedWithOrderAndContent",
        run: async () => {
          const { group } = await readTurnFrames()
          const appends = group.appends
          if (appends.length < MIN_STREAM_FRAMES) {
            throw new Error(
              `帧 append 数 ${appends.length} < 下限 ${MIN_STREAM_FRAMES}` +
              `（正文 ${byteLength(LONG_TEXT)} 字节；faux 约 16 字符一个 delta 的估算值不是断言）`,
            )
          }

          // 顺序：文件里的帧 append 必须按 seq 严格递增（FIFO + 合并等价性在真实链路上的表现）。
          let previousSeq = 0
          for (const append of appends) {
            if (!(append.seq > previousSeq)) {
              throw new Error(`帧 append 的 seq 未严格递增（文件顺序）: ${previousSeq} → ${append.seq}`)
            }
            previousSeq = append.seq
          }

          // 内容：全部 text_delta 的 delta 按序拼接后必须**包含**末尾的唯一哨兵。
          // 不要求与 LONG_TEXT 整段相等：宿主对正文有投影/过滤的可能，这里钉的是
          // 「真实链路把这段流式内容按序完整送达，连尾段都在」。
          const deltas: string[] = []
          for (const append of appends) {
            const delta = textDeltaOf(append.value)
            if (delta !== undefined) deltas.push(delta)
          }
          if (deltas.length === 0) {
            const types = [...new Set(appends.map(frameTypeOf))].join("/")
            throw new Error(`本回合没有任何 text_delta 帧（出现的帧类型: ${types}）`)
          }
          const joined = deltas.join("")
          if (!joined.includes(SENTINEL)) {
            throw new Error(
              `按 seq 升序拼接的 ${deltas.length} 个 text_delta 不含唯一哨兵 ${SENTINEL}：` +
              `拼接后 ${byteLength(joined)} 字节，尾部 ${JSON.stringify(joined.slice(-80))}`,
            )
          }
        },
      },
      {
        // T-3 + T-6 的真实链路侧：帧在缓冲里 → 一次非帧提交（assistant entry）把缓冲冲干净，
        // 并在**同一条多写事务**里立即落盘。判据两条：entry 行确实在盘上（本次读的就是文件）、
        // entry 的 seq 大于该帧组内所有 append 的 seq。
        type: "expectEntryCommitFollowsFramesAndLandsImmediately",
        run: async () => {
          const { dump, group } = await readTurnFrames()
          const entry = dump.writes.find(
            (write): write is Extract<CommittedWrite, { kind: "entry" }> =>
              write.kind === "entry" && write.id === group.responseEntryId,
          )
          if (!entry) {
            throw new Error(`本回合 assistant entry（${group.responseEntryId}）不在盘上: ${dump.path}`)
          }
          if (entry.type !== "message" || entry.message.role !== "assistant") {
            throw new Error(
              `响应条目不是 assistant 消息条目: type=${entry.type}` +
              `${entry.type === "message" ? ` role=${entry.message.role}` : ""}`,
            )
          }
          const maxFrameSeq = Math.max(...group.appends.map(append => append.seq))
          if (!(entry.seq > maxFrameSeq)) {
            throw new Error(
              `assistant entry 的 seq 不大于帧 append 的 seq: entry=${entry.seq}（${entry.id}），` +
              `帧最大 seq=${maxFrameSeq}（${group.appends.length} 条）—— 回合收尾没有把帧缓冲冲干净`,
            )
          }
        },
      },
      {
        // T-4 的读侧：**另一个仓库实例**（独立装饰器与独立缓冲，不会替第一个实例 flush）从
        // 磁盘重建状态。帧列表在终局事务里被 list/delete（见 snapshotBeforeFrameDelete 的注释），
        // 所以读回在「终局事务之前」的字节窗口上验证：同一份真实字节、真实的 replay → readList。
        type: "expectFramesAreReadableThroughFreshRepo",
        run: async () => {
          const { dump, group } = await readTurnFrames()
          const singleton = await getPiSessionRepo()
          const snapshot = snapshotBeforeFrameDelete(dump, group)

          // 会话布局（`--<cwd>--/<时间戳>_<id>.jsonl`）只有一处定义：从实时路径上切出相对部分，
          // 不在场景里重写编码规则。
          const liveRoot = singleton.sessionsRoot
          if (!dump.path.startsWith(`${liveRoot}/`)) {
            throw new Error(`会话文件不在会话根下: path=${dump.path} root=${liveRoot}`)
          }
          const relative = dump.path.slice(liveRoot.length + 1)
          const slash = relative.indexOf("/")
          if (slash <= 0) throw new Error(`会话文件不在 --cwd-- 子目录下: ${relative}`)

          const plain = new TauriExecutionEnv(await runtimePath("data"))
          const root = fileOk(await plain.createTempDir("deskpet-live-frame-replay-", BACKGROUND_CONTEXT))
          try {
            const directory = `${root}/${relative.slice(0, slash)}`
            fileOk(await plain.createDir(directory, undefined, BACKGROUND_CONTEXT))
            fileOk(await plain.writeFile(`${directory}/${relative.slice(slash + 1)}`, snapshot, BACKGROUND_CONTEXT))

            const replayRepo = await createPiSessionRepo({ sessionsRoot: root, cwd: singleton.cwd })
            try {
              const sessionId = getActiveSessionId()
              const metadata = (await replayRepo.list(undefined, BACKGROUND_CONTEXT))
                .find(item => item.id === sessionId)
              if (!metadata) throw new Error(`新仓库实例未列举到快照会话 ${sessionId}: ${relative}`)
              const reopened = await replayRepo.open(metadata, BACKGROUND_CONTEXT)
              try {
                const elements = await reopened.readList(
                  pendingAssistantFrames(group.operationId, group.responseEntryId),
                  { order: "asc" },
                  BACKGROUND_CONTEXT,
                )
                if (elements.length !== group.appends.length) {
                  throw new Error(
                    `新仓库实例读回的帧数 ${elements.length} ≠ 原始文件里的 ${group.appends.length} 条` +
                    `（key=${group.key}）：落盘字节在 replay 路径上丢帧`,
                  )
                }
                // 逐项比对：seq 与内容都要与原始文件逐一相等（顺序由 readList 的 asc + 逐项 seq 相等共同钉住）。
                const deltas: string[] = []
                for (let index = 0; index < elements.length; index++) {
                  const stored = elements[index]
                  const raw = group.appends[index]
                  if (stored.seq !== raw.seq) {
                    throw new Error(`第 ${index} 帧的 seq 不一致: readList=${stored.seq} 原始文件=${raw.seq}`)
                  }
                  const storedDelta = textDeltaOf(stored.value)
                  const rawDelta = textDeltaOf(raw.value)
                  if (storedDelta !== rawDelta) {
                    throw new Error(
                      `第 ${index} 帧的内容不一致: readList=${JSON.stringify(storedDelta)?.slice(0, 80)}` +
                      ` 原始文件=${JSON.stringify(rawDelta)?.slice(0, 80)}`,
                    )
                  }
                  if (storedDelta !== undefined) deltas.push(storedDelta)
                }
                // 内容证据：读回并拼接后的 text_delta 仍包含唯一哨兵（与 check 1 同一判据）。
                const joined = deltas.join("")
                if (!joined.includes(SENTINEL)) {
                  throw new Error(`新仓库实例读回并拼接后的 text_delta 不含唯一哨兵 ${SENTINEL}`)
                }
              } finally {
                await reopened.close(BACKGROUND_CONTEXT)
              }
            } finally {
              await replayRepo.close(BACKGROUND_CONTEXT)
            }
          } finally {
            await plain.remove(root, { recursive: true, force: true }, BACKGROUND_CONTEXT)
          }
        },
      },
    ],
  }],
}

export default 帧节流流式
