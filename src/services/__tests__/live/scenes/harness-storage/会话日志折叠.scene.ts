// ==========================================
// 会话日志折叠场景（T5.07）—— 临时会话根上的真实折叠：S-1、S-2、S-3、S-4、S-6
//
// 本场景证的是**折叠正确性**（折完还是同一份逻辑状态）。三条明确的边界：
//   · **不证中断安全** —— 折叠写到一半被打断、rename 失败、临时文件残留、进程被强杀后的盘上
//     形态，归 hs-08；本场景只在「没有写入者」的静止文件上折叠（先 close → 冲帧缓冲 → 折叠）。
//   · **不证地址交界** —— 折叠前后展示地址（shortenAddresses 的取值）逐字一致，归 hs-08；
//     本场景只钉 entryId / seq 与重放出的逻辑状态，一个地址取值都不读。
//   · **不重复上游的拒绝行为** —— `JsonlStorage.open` 对 storageVersion ≠ 1 的既有拒绝由 hs-01
//     的官方一致性套件覆盖；S-6 在存储层唯一可观测的形态是「文件没被动过」。
//
// 被测规则（`src/services/engine/pi/session-fold.ts` 是唯一真相源，本文件逐条照抄口径）：
//   · **死 key**：该 key 有 `delete`，且**最后一次 delete 之后没有同 key 的其它写** ——
//     只有「行号严格小于最后一次 delete 行号」的 `list/append` / `value/set` 可丢；
//     delete 行自己与 delete 之后的写入（先 delete 再 append 的那种）一律保留。
//   · **整行粒度**：仅当一行的**全部**写入都可丢时才删整行 —— 一行里只要有一个保留写入
//     （delete / entry / usage / 活 key 的 set），整行逐字保留。夹具里的多写行把「可丢的
//     append」与「保留的 set」放在同一行，专门钉这条边界。
//   · **保留行是原文子串**：输出 = header 原文 + 保留行原文的换行连接，从不重新序列化 ——
//     S-2 因此是构造性成立的，本场景仍把它断言出来（见 expectRetainedLinesByteIdentical）。
//
// 闸门（`FOLD_POLICY`，三者的**与**；字节口径一律 UTF-8，与 Rust `file_write` 的
// `content.len()`、`fileInfo` 的 size 同口径）：
//   ① 文件字节 > `minFileBytes`（不过就在 stat 后掉头，skip "probe-too-small"）；
//   ② 可回收字节 ≥ `minReclaimBytes`；③ 可回收比例 ≥ `minReclaimRatio`。
//   夹具的回收量按 `minReclaimBytes × 4` 反推，并断言这次折叠真的跨过了闸门 2 的两条下界 ——
//   夹具缩水时宁可让断言炸掉，也不能把 skip 伪装成通过。
//
// 夹具的两条盘上纪律（`JsonlStorage.open` 重放时 `validateCommittedWrites` 要求 seq 严格递增，
// `harness/session/commit.js`）：① raw append 的 seq 从「盘上当前最大 seq + 1」起步，不从 1
// 开始；② raw append 之前先 `session.close()` 再冲一次帧缓冲 —— 句柄的内存态与盘上文件分叉会
// 同时破坏重放与折叠「无写入者」的前置条件。
//
// 行形状全部由上游构造器产出（`appendList` / `deleteList` / `setValue` / `deleteValue` /
// `entryLabel` / `branchTip` + `commitWrite`），多写行按上游数组形态拼 —— 不手写 JSON 近似。
// 载荷里 ASCII 与中文各占一半且**字符数相同、UTF-8 字节数不同**（§1.3 的字节口径陷阱）：
// 只按 `String.length` 计数的实现过不了「折叠前后字节 = 盘上文件字节」这条断言。
//
// 场景类型 unit（不跑模型）：只走真实 Rust IPC 与真实 commit 路径。
// ==========================================

import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core"
import type { FileError, JsonlSessionMetadata, Result } from "@earendil-works/pi-agent-core"
import {
  JSONL_STORAGE_VERSION,
  appendList,
  branchTip,
  commitWrite,
  deleteList,
  deleteValue,
  entryLabel,
  pendingAssistantFrames,
  setValue,
} from "@earendil-works/pi-agent-core/harness/session"
import type { Write } from "@earendil-works/pi-agent-core/harness/session"
import {
  FOLD_POLICY,
  createPiSessionRepo,
  flushSessionFrameWrites,
  foldSessionFile,
  logStateDigest,
  prepareFold,
  readFoldLog,
} from "@/services/engine/pi"
import type { FoldOutcome, PiSessionRepo } from "@/services/engine/pi"
import { PI_LANE } from "@/services/session"
import { runtimePath } from "@/services/paths"
import { TauriExecutionEnv } from "@/services/tool/pi/tauri-execution-env"
import type { SceneDef } from "../../types"

const textEncoder = new TextEncoder()

/** 字节口径：UTF-8（与 Rust `file_write` / `fileInfo` 同口径），禁用 `String.length`。 */
function byteLength(text: string): number {
  return textEncoder.encode(text).byteLength
}

function fileOk<T>(result: Result<T, FileError>): T {
  if (!result.ok) throw new Error(`期望成功，实际失败: ${result.error.message}`)
  return result.value
}

// ── 夹具参数（全部按闸门与载荷口径推导，不抄实现里的数字）──

/** 真实提交的条目条数：ASCII 载荷与中文载荷各一半。 */
const ENTRY_COUNT = 12
/** 每条条目载荷的**字符数**：两种载荷相同 —— 字符数相同、UTF-8 字节数差 3 倍。 */
const ENTRY_PAD_CHARS = 3_000
/** 帧增量里的中文填充字符数：让这份夹具的「字符数」与「字节数」显著分叉。 */
const FRAME_PAD_CHARS = 120
/** 可回收量的目标 = 闸门 2 的字节下界 × 4（比例下界在断言里另算）。 */
const RECLAIM_TARGET_BYTES = FOLD_POLICY.minReclaimBytes * 4
/** K2 在最后一次 delete **之前**的 append 条数（随 delete 一起成为死 key，整段可回收）。 */
const PRE_DELETE_APPENDS = 4
/** K2 在最后一次 delete **之后**的 append 条数（该 key 因此不是死 key，必须逐字保留）。 */
const REVIVED_APPENDS = 2
/** K3 的 value/set 条数（紧随其后的 value/delete 让它们成为死 key）。 */
const LABEL_SETS = 2
/**
 * 夹具自检：折叠前的 UTF-8 字节数至少是字符数的这个倍数。
 *
 * 它守的是「夹具不能退化成纯 ASCII 载荷」：中文载荷在场时 `String.length` 与 UTF-8 字节数
 * 才会分叉。真正的字符口径判据是上面 check 里「折叠前后字节 = 盘上文件字节」那条（精确比对），
 * 这里只是不变量检查，所以取一个宽松的下界 —— 本夹具实测 1.809 倍（离线探针）。
 */
const MIN_BYTES_PER_CHAR = 1.5

/**
 * 量化验收线：折叠后的字节不得超过折叠前的这个比例。
 * 是**场景的验收值**、不是实现常量 —— 来源是执行方案 §7.1 的实测锚（293879 / 792898 ≈ 0.371）；
 * 本夹具折叠后只剩约一成，实际比例远低于它。只断「变小」的话 1 字节的收益也能过。
 */
const MAX_ACCEPTED_SIZE_RATIO = 0.45

/** 夹具用的 key / 地址：namespace 与 key 串一律由上游构造器给出，场景不自己拼地址。 */
const FOLD_OP = "op-fold"
const FOLD_RESP = "resp-fold"
const REVIVED_OP = "op-fold-revived"
const REVIVED_RESP = "resp-fold-revived"

// ── 行构造：形状照抄上游，只有 seq 由场景按盘上高水位分配 ──

/**
 * 一条原始日志行：上游 `serializeTransaction` 的形态（`harness/session/jsonl/storage.js`：
 * 恰好 1 条写时是对象，≥2 条时是数组）。写入内容全部来自上游构造器 + `commitWrite`，
 * 因此字段集合与生产落盘逐字同形。
 */
function rawLine(writes: readonly Write[], firstSeq: number, timestamp: number): string {
  const committed = writes.map((write, index) => commitWrite(write, firstSeq + index, timestamp))
  return JSON.stringify(committed.length === 1 ? committed[0] : committed)
}

/** 一帧 thinking_delta 的载荷；`prefix` + `index` 保证每一行的 delta 全局唯一（可做零命中判据）。 */
function framePayload(prefix: string, index: number): { type: "thinking_delta"; contentIndex: number; delta: string } {
  return { type: "thinking_delta", contentIndex: 0, delta: `帧-${prefix}-${index}-${"田".repeat(FRAME_PAD_CHARS)}` }
}

/** 全部写（单写行 = 1 条，数组行 = 多条），按文件顺序；header 行不在其中。 */
function transactionWrites(content: string): Record<string, unknown>[] {
  const writes: Record<string, unknown>[] = []
  for (const line of readFoldLog(content).lines) {
    const parsed: unknown = JSON.parse(line)
    for (const write of Array.isArray(parsed) ? parsed : [parsed]) writes.push(write as Record<string, unknown>)
  }
  return writes
}

/** 全部 `kind === "entry"` 的整条写入（含 id / seq / parentId / timestamp），按文件顺序。 */
function entryWritesOf(content: string): Record<string, unknown>[] {
  return transactionWrites(content).filter(write => write.kind === "entry")
}

/** 全部写入用到的 seq。 */
function seqsOf(content: string): number[] {
  return transactionWrites(content)
    .map(write => write.seq)
    .filter((seq): seq is number => typeof seq === "number")
}

/**
 * 盘上当前的 seq 高水位：raw append 的 seq 必须从它之后起步 —— 从 1 开始会让
 * `JsonlStorage.open` 以 "Non-monotonic storage sequence" 拒绝整个文件。
 */
function maxSeqOf(content: string): number {
  let max = 0
  for (const seq of seqsOf(content)) {
    if (seq > max) max = seq
  }
  return max
}

// ── 夹具正文：一条整段可回收的帧列表 + 一条「先 delete 再 append」的 key + 一条 value 死 key ──

interface RawFixture {
  /** 追加到会话文件末尾的整段原文（以换行结尾）。 */
  text: string
  /** 折叠**必须**删掉的整行（原文，无换行）。 */
  dropped: string[]
  /** 折叠**必须**逐字保留的探针行（原文，无换行）+ 保留理由。 */
  kept: { line: string; why: string }[]
}

/**
 * 构造盘上追加的整段内容，并按「可回收 / 必须保留」分好类 —— check 的期望值全部来自这份分类，
 * 不另抄一份。
 *
 * 结构（顺序即语义）：
 *   ① 多写行：可丢的帧 append + 保留的 branch tip set 同一行 ⇒ 整行保留；
 *   ② K1 帧突发：每条一整行 append，全部排在 K1 最后一次 delete 之前 ⇒ 整段可回收；
 *   ③ K1 的 list/delete：delete 行永远保留，它的存在让 ② 成为死 key；
 *   ④ K2：先 append、再 delete、**再 append** —— 最后一次 delete 之前的可回收，
 *      之后的（REVIVED_APPENDS 条）必须逐字保留；
 *   ⑤ K3：value/set × LABEL_SETS + value/delete（同一个 value key 的整段可回收）。
 */
function buildRawFixture(startSeq: number, lastEntryId: string): RawFixture {
  const timestamp = Date.now()
  const lines: string[] = []
  const dropped: string[] = []
  const kept: { line: string; why: string }[] = []
  let seq = startSeq

  const drop = (line: string): void => {
    lines.push(line)
    dropped.push(line)
  }
  const keep = (line: string, why: string): void => {
    lines.push(line)
    kept.push({ line, why })
  }

  const frames = pendingAssistantFrames(FOLD_OP, FOLD_RESP)

  // ① 多写行（整行粒度的边界）：放在突发头部只是为了让 seq 账目一眼可算，位置不影响判定。
  keep(
    rawLine(
      [appendList(frames, framePayload(FOLD_OP, 0)), setValue(branchTip(PI_LANE), lastEntryId)],
      seq,
      timestamp,
    ),
    "多写行里含保留写入（活 key 的 branch tip set）：整行逐字保留，行内的帧 append 也不许丢",
  )
  seq += 2

  // ② K1 的帧突发：整段排在最后一次 delete 之前 ⇒ 全部可回收。
  let burstBytes = 0
  for (let index = 1; burstBytes < RECLAIM_TARGET_BYTES; index++) {
    const line = rawLine([appendList(frames, framePayload(FOLD_OP, index))], seq, timestamp)
    drop(line)
    burstBytes += byteLength(line) + 1
    seq += 1
  }

  // ③ K1 的最后一次 delete。
  keep(rawLine([deleteList(frames)], seq, timestamp), "delete 行永远保留")
  seq += 1

  // ④ K2：先 delete 再 append —— 「先 delete 后又被写」的 key 不是死 key。
  const revived = pendingAssistantFrames(REVIVED_OP, REVIVED_RESP)
  for (let index = 0; index < PRE_DELETE_APPENDS; index++) {
    drop(rawLine([appendList(revived, framePayload(REVIVED_OP, index))], seq, timestamp))
    seq += 1
  }
  keep(rawLine([deleteList(revived)], seq, timestamp), "delete 行永远保留")
  seq += 1
  for (let index = 0; index < REVIVED_APPENDS; index++) {
    keep(
      rawLine([appendList(revived, framePayload(REVIVED_RESP, index))], seq, timestamp),
      "最后一次 delete 之后的 append：该 key 不是死 key，这一行必须保留",
    )
    seq += 1
  }

  // ⑤ K3：value 死 key。
  const label = entryLabel(lastEntryId)
  for (let index = 0; index < LABEL_SETS; index++) {
    drop(rawLine([setValue(label, `折叠探针-${index}`)], seq, timestamp))
    seq += 1
  }
  keep(rawLine([deleteValue(label)], seq, timestamp), "delete 行永远保留")

  return { text: `${lines.join("\n")}\n`, dropped, kept }
}

// ── 夹具：真仓库提交造条目 + raw append 造帧，然后在静止文件上折叠一次 ──

interface FoldFixture {
  /** 夹具所属 trial：模块级变量跨 trial 存活（同页复用），trial 变了必须重建。 */
  trial: number
  /** **未包装**的真实 IPC env：直读磁盘（绕过装饰器的读前 flush），也负责收尾删根。 */
  env: TauriExecutionEnv
  root: string
  repo: PiSessionRepo
  metadata: JsonlSessionMetadata
  /** 折叠前的盘上全文。 */
  before: string
  /** 折叠后的盘上全文。 */
  after: string
  /** 折叠前 / 折叠后的盘上真实字节（Rust `fileInfo`）。 */
  bytesOnDiskBefore: number
  bytesOnDiskAfter: number
  outcome: FoldOutcome
  expectDropped: string[]
  expectKept: { line: string; why: string }[]
}

let foldFixture: FoldFixture | undefined

async function ensureFoldFixture(trial: number): Promise<FoldFixture> {
  if (foldFixture && foldFixture.trial === trial) return foldFixture
  if (foldFixture) {
    // 上一 trial 的夹具（例如上一轮在某条 check 中途超时被放弃）：先收尾再重建，
    // 否则盘上残留会与这一轮的同名 key 串味。
    const stale = foldFixture
    foldFixture = undefined
    await disposeFoldFixture(stale)
  }
  foldFixture = await buildFoldFixture(trial)
  return foldFixture
}

async function disposeFoldFixture(fixture: FoldFixture): Promise<void> {
  const context = BACKGROUND_CONTEXT
  // 收尾失败不掩盖调用方的失败：这里只是把临时根删掉，根因留痕在上游（场景失败报告）。
  await fixture.repo.close(context).catch(() => undefined)
  await fixture.env.remove(fixture.root, { recursive: true, force: true }, context).catch(() => undefined)
}

async function buildFoldFixture(trial: number): Promise<FoldFixture> {
  const context = BACKGROUND_CONTEXT
  const env = new TauriExecutionEnv(await runtimePath("data"))
  const root = await runtimePath("data", `fold-${crypto.randomUUID()}`)
  const repo = await createPiSessionRepo({ sessionsRoot: root })
  try {
    // ① 真仓库 create + 真分支提交造条目：entry 行的 id / seq / parentId / timestamp 全部来自
    //    真实提交（`appendToBranch` 落的正是「entry + branch tip set」的多写事务）。
    const session = await repo.create({ id: "fold-probe" }, context)
    const lane = (await session.branch(PI_LANE, context)) ?? (await session.createBranch(PI_LANE, null, context))
    let lastEntryId = ""
    for (let index = 0; index < ENTRY_COUNT; index++) {
      // 偶数条 ASCII 载荷、奇数条中文载荷：字符数相同、字节数差 3 倍（§1.3 的字节口径陷阱）。
      const pad = index % 2 === 0 ? "x".repeat(ENTRY_PAD_CHARS) : "田".repeat(ENTRY_PAD_CHARS)
      lastEntryId = await lane.appendCustomEntry("fold-probe", { index, pad }, context)
    }
    await session.close(context)
    // 先关句柄、再冲帧缓冲（与 releasePiSession 同序）：折叠的前置条件之一是「没有写入者」。
    await flushSessionFrameWrites(context)

    // ② raw append：读一次盘上高水位定 seq，整段一次落盘（一次 IPC，不是几百次小写）。
    const path = session.metadata.path
    const raw = buildRawFixture(maxSeqOf(fileOk(await env.readTextFile(path, context))) + 1, lastEntryId)
    fileOk(await env.appendFile(path, raw.text, context))
    const before = fileOk(await env.readTextFile(path, context))

    // ③ 折叠（与 `open` 前的兜底挂点是同一个驱动函数），前后各记一次盘上真实字节。
    const bytesOnDiskBefore = fileOk(await env.fileInfo(path, context)).size
    const outcome = await repo.foldSession(session.metadata, context)
    const after = fileOk(await env.readTextFile(path, context))
    const bytesOnDiskAfter = fileOk(await env.fileInfo(path, context)).size

    return {
      trial,
      env,
      root,
      repo,
      metadata: session.metadata,
      before,
      after,
      bytesOnDiskBefore,
      bytesOnDiskAfter,
      outcome,
      expectDropped: raw.dropped,
      expectKept: raw.kept,
    }
  } catch (error) {
    // 建夹失败也要把临时根收掉：根因是这里抛出的那个，收尾失败不再叠加一层。
    await repo.close(context).catch(() => undefined)
    await env.remove(root, { recursive: true, force: true }, context).catch(() => undefined)
    throw error
  }
}

// ── S-6 的探针：只改 header 一个字段 ──

/**
 * 版本探针的正文：与夹具同形的帧 append 行铺到**超过闸门 1** 的体积。
 *
 * 这一步不能省：文件没过闸门 1 时 `foldSessionFile` 在读正文之前就掉头，S-6 的断言会退化成
 * 「小文件不折叠」，与本覆盖点无关。探针文件不回给上游 open，因此 seq 从 1 起（能过白名单
 * 解析即可）。
 */
function versionProbePadding(): string {
  const frames = pendingAssistantFrames(FOLD_OP, FOLD_RESP)
  const timestamp = Date.now()
  const lines: string[] = []
  let bytes = 0
  for (let index = 0; bytes <= FOLD_POLICY.minFileBytes; index++) {
    const line = rawLine([appendList(frames, framePayload(FOLD_OP, index))], index + 1, timestamp)
    lines.push(line)
    bytes += byteLength(line) + 1
  }
  return `${lines.join("\n")}\n`
}

export const 会话日志折叠: SceneDef = {
  meta: {
    caseId: "harness-session-log-fold",
    module: "harness-storage",
    contractId: "hs-07",
    description: "会话 JSONL 的纯删除式折叠：只删不增、保留行逐字不变、entryId 与 seq 不变、已删 key 的 append 全部回收、版本不匹配跳过",
    depth: "deep",
    suite: "regression",
    entry: "unit",
    tags: ["harness-storage", "session-fold", "storage"],
  },
  turns: [{
    index: 1,
    description: "在临时会话根上折叠一次，逐条钉住回收、逐字保留、entry 身份、逻辑状态摘要、版本跳过与幂等",
    userText: "校验会话日志折叠的正确性。",
    checks: [
      {
        // S-4：可回收的整行真的被回收，且行级账目与夹具分类精确一致。
        type: "expectFoldReclaimsDeletedKeyAppends",
        run: async (ctx) => {
          const fixture = await ensureFoldFixture(ctx.trial)
          const { outcome, after, before } = fixture
          if (outcome.kind !== "folded") {
            throw new Error(`夹具应当产生一次真实折叠，实际 skipped(${outcome.reason})`)
          }

          // ① 字节账目 = 盘上真实文件字节（UTF-8 口径）：只按 String.length 计数的实现在中文
          //    载荷上会差出 2 倍以上，这一条就是它的出口。
          if (outcome.bytesBefore !== fixture.bytesOnDiskBefore) {
            throw new Error(`折叠前字节与盘上文件不符：outcome=${outcome.bytesBefore} 盘上=${fixture.bytesOnDiskBefore}`)
          }
          if (outcome.bytesAfter !== fixture.bytesOnDiskAfter) {
            throw new Error(`折叠后字节与盘上文件不符：outcome=${outcome.bytesAfter} 盘上=${fixture.bytesOnDiskAfter}`)
          }
          if (byteLength(before) < before.length * MIN_BYTES_PER_CHAR) {
            throw new Error(`夹具的中文载荷不足：${byteLength(before)} B / ${before.length} 字符，字节口径无从区分`)
          }

          // ② 闸门 2 的两条下界都真的被跨过（夹具按 FOLD_POLICY 反推，不是碰巧过的）。
          const reclaimed = outcome.bytesBefore - outcome.bytesAfter
          if (reclaimed < FOLD_POLICY.minReclaimBytes) {
            throw new Error(`回收 ${reclaimed} B < minReclaimBytes ${FOLD_POLICY.minReclaimBytes} B：夹具没过闸门 2`)
          }
          if (reclaimed < outcome.bytesBefore * FOLD_POLICY.minReclaimRatio) {
            throw new Error(
              `回收比例 ${(reclaimed / outcome.bytesBefore).toFixed(3)} < minReclaimRatio ${FOLD_POLICY.minReclaimRatio}：夹具没过闸门 2b`,
            )
          }

          // ③ 量化验收线：只断「变小」的话 1 字节的收益也能过。
          if (!(outcome.bytesAfter < outcome.bytesBefore)) {
            throw new Error(`折叠后没有变小：${outcome.bytesBefore} → ${outcome.bytesAfter}`)
          }
          if (outcome.bytesAfter > outcome.bytesBefore * MAX_ACCEPTED_SIZE_RATIO) {
            throw new Error(
              `回收不足：${outcome.bytesAfter} / ${outcome.bytesBefore} = ${(outcome.bytesAfter / outcome.bytesBefore).toFixed(3)} > ${MAX_ACCEPTED_SIZE_RATIO}`,
            )
          }

          // ④ 行级账目：删掉的整行**恰好**是夹具标为可回收的那些 —— 不多删（误删活 key 的写）
          //    也不少删（漏回收）。
          if (outcome.droppedLines !== fixture.expectDropped.length) {
            throw new Error(`删除行数 ${outcome.droppedLines} ≠ 夹具可回收行数 ${fixture.expectDropped.length}`)
          }
          if (outcome.linesAfter >= outcome.linesBefore) {
            throw new Error(`行数没有减少：${outcome.linesBefore} → ${outcome.linesAfter}`)
          }

          // ⑤ 被删 key 的全部 append 行在折叠后的文本里零命中。
          for (const line of fixture.expectDropped) {
            if (after.includes(line)) {
              throw new Error(`可回收的 append 行仍在折叠结果里：${line.slice(0, 120)}…`)
            }
          }

          // ⑥ 保留探针逐字在盘上（delete 行、被删 key 之后又 append 的那一行、多写行）。
          for (const probe of fixture.expectKept) {
            if (!after.includes(`${probe.line}\n`)) {
              throw new Error(`应逐字保留的行不在折叠结果里（${probe.why}）：${probe.line.slice(0, 120)}…`)
            }
          }
        },
      },
      {
        // S-2：只删不增 —— 保留行是原文子串、行序不变、header 原样、仍以换行收尾。
        type: "expectRetainedLinesByteIdentical",
        run: async (ctx) => {
          const fixture = await ensureFoldFixture(ctx.trial)
          const beforeLog = readFoldLog(fixture.before)
          const afterLog = readFoldLog(fixture.after)
          if (afterLog.torn) throw new Error("折叠结果以不完整的尾行结束（原文是完整行文件）")
          if (!fixture.after.endsWith("\n")) throw new Error("折叠结果没有以换行结尾")
          if (afterLog.headerLine !== beforeLog.headerLine) {
            throw new Error(`header 行被改写了：\n前 ${beforeLog.headerLine}\n后 ${afterLog.headerLine}`)
          }
          if (!fixture.after.startsWith(`${beforeLog.headerLine}\n`)) {
            throw new Error("折叠结果不是以 header 行开头")
          }

          const beforeLines = [beforeLog.headerLine, ...beforeLog.lines]
          const afterLines = [afterLog.headerLine, ...afterLog.lines]
          if (afterLines.length >= beforeLines.length) {
            throw new Error(`折叠没有减少行数：${beforeLines.length} → ${afterLines.length}`)
          }

          // ① 每一行都能在折叠前的文本里按行边界逐字找到（不是子串巧合）。
          for (const line of afterLines) {
            if (!fixture.before.includes(`${line}\n`)) {
              throw new Error(`折叠结果里的行不是原文的子串：${line.slice(0, 120)}…`)
            }
          }

          // ② 折叠前的行序是折叠后的子序列 —— 没有重排、没有新造行。
          let cursor = 0
          for (const line of afterLines) {
            while (cursor < beforeLines.length && beforeLines[cursor] !== line) cursor += 1
            if (cursor === beforeLines.length) {
              throw new Error(`折叠结果的行序不是原文的子序列：${line.slice(0, 120)}…`)
            }
            cursor += 1
          }
        },
      },
      {
        // S-3：entry 行逐字不动（id / seq / parentId / timestamp），也不出现新的 seq。
        type: "expectEntryIdsAndSeqsUnchanged",
        run: async (ctx) => {
          const fixture = await ensureFoldFixture(ctx.trial)
          const beforeEntries = entryWritesOf(fixture.before)
          const afterEntries = entryWritesOf(fixture.after)
          if (beforeEntries.length === 0) throw new Error("夹具里没有 entry 行：这条断言会退化成空比较")

          const beforeJson = JSON.stringify(beforeEntries)
          const afterJson = JSON.stringify(afterEntries)
          if (beforeJson !== afterJson) {
            throw new Error(
              `entry 集合被改动了（共 ${beforeEntries.length} → ${afterEntries.length} 条）：\n前 ${beforeJson.slice(0, 240)}…\n后 ${afterJson.slice(0, 240)}…`,
            )
          }

          const knownSeqs = new Set(seqsOf(fixture.before))
          for (const seq of seqsOf(fixture.after)) {
            if (!knownSeqs.has(seq)) throw new Error(`折叠后出现了折叠前不存在的 seq: ${seq}`)
          }
        },
      },
      {
        // S-1：折叠前后重放出的逻辑状态摘要相同（驱动落盘的正是同一个摘要）。
        type: "expectReplayDigestEqual",
        run: async (ctx) => {
          const fixture = await ensureFoldFixture(ctx.trial)
          const beforeDigest = await logStateDigest(readFoldLog(fixture.before))
          const afterDigest = await logStateDigest(readFoldLog(fixture.after))
          if (beforeDigest !== afterDigest) {
            throw new Error(`折叠前后逻辑状态摘要不一致：\n前 ${beforeDigest}\n后 ${afterDigest}`)
          }
          if (fixture.outcome.kind === "folded" && fixture.outcome.digest !== afterDigest) {
            throw new Error(
              `驱动报告给调用方的摘要与场景独立重算的不一致：${fixture.outcome.digest} ≠ ${afterDigest}`,
            )
          }
        },
      },
      {
        // S-6：header 版本不在白名单内 ⇒ 跳过，且文件逐字未动。
        type: "expectVersionMismatchSkips",
        run: async (ctx) => {
          const context = BACKGROUND_CONTEXT
          const fixture = await ensureFoldFixture(ctx.trial)
          const headerLine = readFoldLog(fixture.before).headerLine
          const header = JSON.parse(headerLine) as Record<string, unknown>
          const padding = versionProbePadding()

          // 差分对照（纯函数，不碰盘）：同一份正文配真 header 时结论是「没有整行可回收」，
          // 说明下面两个探针「文件没被动过」的成因确实是 header 版本，而不是正文不可折叠。
          const withRealHeader = prepareFold(readFoldLog(`${headerLine}\n${padding}`))
          if (withRealHeader.kind !== "skip" || withRealHeader.reason !== "nothing-to-reclaim") {
            throw new Error(`对照用的真 header 正文应当只是没有可回收行，实际 ${JSON.stringify(withRealHeader)}`)
          }

          // 变体 A：storageVersion 不是本层白名单里的那一个（上游升版本）。
          // 变体 B：JSONL 格式版本不是 4（包导出面上没有格式版本常量，与实现里硬编码 4 同因）。
          const mutations: { path: string; header: Record<string, unknown> }[] = [
            {
              path: `${fixture.root}/fold-version-ahead.jsonl`,
              header: { ...header, storageVersion: JSONL_STORAGE_VERSION + 1 },
            },
            { path: `${fixture.root}/fold-format-behind.jsonl`, header: { ...header, v: 3 } },
          ]

          for (const mutation of mutations) {
            const content = `${JSON.stringify(mutation.header)}\n${padding}`
            fileOk(await fixture.env.writeFile(mutation.path, content, context))
            const result = await foldSessionFile(fixture.env, mutation.path, context)
            if (result.kind !== "skipped" || result.reason !== "unknown-format") {
              throw new Error(`版本不匹配应当 skip(unknown-format)，实际 ${JSON.stringify(result)}`)
            }
            // 功能不受影响在存储层的可观测形态：文件一个字节都没被碰过。
            const onDisk = fileOk(await fixture.env.readTextFile(mutation.path, context))
            if (onDisk !== content) throw new Error(`版本不匹配时文件被改动了: ${mutation.path}`)
            // 探针必须真的超过闸门 1，否则上面跳过的是闸门 1 而不是 header 判定。
            const size = fileOk(await fixture.env.fileInfo(mutation.path, context)).size
            if (size <= FOLD_POLICY.minFileBytes) {
              throw new Error(`探针文件 ${size} B 没超过 minFileBytes ${FOLD_POLICY.minFileBytes} B：断言退化成了闸门 1`)
            }
          }
        },
      },
      {
        // 幂等：同一个文件再折一次，磁盘上一个字节都不会动。
        type: "expectFoldIsIdempotent",
        run: async (ctx) => {
          const context = BACKGROUND_CONTEXT
          const fixture = await ensureFoldFixture(ctx.trial)
          try {
            const second = await fixture.repo.foldSession(fixture.metadata, context)
            if (second.kind !== "skipped") {
              throw new Error(`第二次折叠不应再重写文件，实际 ${JSON.stringify(second)}`)
            }
            // 第二次落在哪条闸门由折叠后的体积决定：本夹具折叠后已低于闸门 1；两条都是
            // 「读完就掉头、不写盘」的路径（闸门 1 甚至连正文都不读）。夹具若换成折叠后仍在
            // 闸门 1 之上的形态，这里自动改判为 nothing-to-reclaim。
            if (fixture.outcome.kind === "folded") {
              const expectedReason = fixture.outcome.bytesAfter <= FOLD_POLICY.minFileBytes
                ? "probe-too-small"
                : "nothing-to-reclaim"
              if (second.reason !== expectedReason) {
                throw new Error(`第二次折叠的跳过原因应为 ${expectedReason}，实际 ${second.reason}`)
              }
            }

            // ① 盘上全文逐字未变。
            const onDisk = fileOk(await fixture.env.readTextFile(fixture.metadata.path, context))
            if (onDisk !== fixture.after) throw new Error("第二次折叠改动了文件")
            const size = fileOk(await fixture.env.fileInfo(fixture.metadata.path, context)).size
            if (size !== fixture.bytesOnDiskAfter) {
              throw new Error(`第二次折叠后字节变了：${fixture.bytesOnDiskAfter} → ${size}`)
            }

            // ② 与体积无关的等价判据：即使文件大到能过闸门 1，也已经没有整行可回收。
            const replan = prepareFold(readFoldLog(fixture.after))
            if (replan.kind !== "skip" || replan.reason !== "nothing-to-reclaim") {
              throw new Error(`折叠结果里仍有可回收的整行：${JSON.stringify(replan).slice(0, 200)}`)
            }
          } finally {
            foldFixture = undefined
            await disposeFoldFixture(fixture)
          }
        },
      },
    ],
  }],
}

export default 会话日志折叠
