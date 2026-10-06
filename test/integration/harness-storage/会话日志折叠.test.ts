// ==========================================
// 会话日志折叠（T5.07）—— 从 test/e2e/scenes/harness-storage/会话日志折叠.scene.ts 迁到 L3（W2）
//
// 本用例证的是**折叠正确性**（折完还是同一份逻辑状态）。三条明确的边界：
//   · **不证中断安全** —— 归 `harness-session-log-fold-crash`；本用例只在「没有写入者」的静止
//     文件上折叠（先 close → 冲帧缓冲 → 折叠）。
//   · **不证地址交界** —— 归 `harness-session-log-fold-address`；本用例只钉 entryId / seq 与
//     重放出的逻辑状态，一个地址取值都不读。
//   · **不重复上游的拒绝行为** —— `JsonlStorage.open` 对 storageVersion ≠ 1 的既有拒绝由
//     hs-01 的官方一致性套件覆盖；S-6 在存储层唯一可观测的形态是「文件没被动过」。
//
// 被测规则（`src/services/engine/harness/session-fold.ts` 是唯一真相源）：
//   · **死 key**：该 key 有 `delete`，且**最后一次 delete 之后没有同 key 的其它写** ——
//     只有「行号严格小于最后一次 delete 行号」的 `list/append` / `value/set` 可丢。
//   · **整行粒度**：仅当一行的**全部**写入都可丢时才删整行 —— 一行里只要有一个保留写入，
//     整行逐字保留。夹具里的多写行把「可丢的 append」与「保留的 set」放在同一行，专钉这条边界。
//   · **保留行是原文子串**：输出 = header 原文 + 保留行原文的换行连接，从不重新序列化。
//
// 闸门（`FOLD_POLICY`，前三个阈值的**与**；字节口径一律 UTF-8）：① 文件字节 > `minFileBytes`；
//   ② 可回收字节 ≥ `minReclaimBytes`；③ 可回收比例 ≥ `minReclaimRatio`。夹具按 `minReclaimBytes × 4`
//   反推回收量，并断言这次折叠真的跨过了闸门 2 的两条下界 —— 夹具缩水时宁可让断言炸掉，
//   也不能把 skip 伪装成通过。
// 尺寸守卫（`尺寸守卫` 组的两条用例）：文件超过 5 MiB（`MAX_TOOL_FILE_BYTES`，写侧上限）仍必须
//   折叠成功 —— 会话读路径无单次大小上限；只有折叠结果仍超写上限才 skip("too-large")。
//
// 盘上纪律（`JsonlStorage.open` 重放要求 seq 严格递增）：raw append 的 seq 从「盘上当前最大
//   seq + 1」起步；raw append 之前先 `session.close()` 再冲一次帧缓冲。
//
// 行形状全部由上游构造器产出（`appendList` / `deleteList` / `setValue` / `deleteValue` /
//   `entryLabel` / `branchTip` + `commitWrite`），多写行按上游数组形态拼 —— 不手写 JSON 近似。
//   载荷里 ASCII 与中文各占一半且**字符数相同、UTF-8 字节数不同**：只按 `String.length` 计数的
//   实现过不了「折叠前后字节 = 盘上文件字节」这条断言。
//
// L3：IPC 由 test/host/node-ipc.ts 顶替（真实 Rust 命令的 Node 等价实现）；仓库/折叠路径同一份产品代码。
// ==========================================

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import {
  FOLD_POLICY,
  createPiSessionRepo,
  flushSessionFrameWrites,
  foldSessionFile,
  logStateDigest,
  prepareFold,
  readFoldLog,
} from "@/services/engine/harness"
import type { FoldOutcome, PiSessionRepo } from "@/services/engine/harness"
import { PI_LANE } from "@/services/session"
import { initPaths, runtimePath } from "@/services/paths"
import { MAX_TOOL_FILE_BYTES, NativeExecutionEnv } from "@/services/tool/pi/native-execution-env"

const textEncoder = new TextEncoder()

/** 字节口径：UTF-8（与 Rust `file_write` / `fileInfo` 同口径），禁用 `String.length`。 */
function byteLength(text: string): number {
  return textEncoder.encode(text).byteLength
}

let dataRoot = ""

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), "deskpet-harness-foldlog-"))
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
 * 夹具自检：折叠前的 UTF-8 字节数至少是字符数的这个倍数（守「夹具不能退化成纯 ASCII 载荷」）。
 * 真正的字符口径判据是下面 check 里「折叠前后字节 = 盘上文件字节」那条（精确比对），这里只是
 * 不变量检查，所以取一个宽松的下界 —— 本夹具实测 1.809 倍（离线探针）。
 */
const MIN_BYTES_PER_CHAR = 1.5

/**
 * 量化验收线：折叠后的字节不得超过折叠前的这个比例。是**场景的验收值**、不是实现常量 ——
 * 来源是执行方案 §7.1 的实测锚（293879 / 792898 ≈ 0.371）；只断「变小」的话 1 字节的收益也能过。
 */
const MAX_ACCEPTED_SIZE_RATIO = 0.45

/** 夹具用的 key / 地址：namespace 与 key 串一律由上游构造器给出，场景不自己拼地址。 */
const FOLD_OP = "op-fold"
const FOLD_RESP = "resp-fold"
const REVIVED_OP = "op-fold-revived"
const REVIVED_RESP = "resp-fold-revived"

// ── 行构造：形状照抄上游，只有 seq 由测试按盘上高水位分配 ──

/**
 * 一条原始日志行：上游 `serializeTransaction` 的形态（恰好 1 条写时是对象，≥2 条时是数组），
 * 写入内容全部来自上游构造器 + `commitWrite`，因此字段集合与生产落盘逐字同形。
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
 * 不另抄一份。结构（顺序即语义）见原场景：① 多写行（可丢帧 + 保留 branch tip set 同行）；
 * ② K1 帧突发；③ K1 的 list/delete；④ K2（先 delete 再 append）；⑤ K3（value 死 key）。
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
  /** **未包装**的真实 IPC env：直读磁盘（绕过装饰器的读前 flush），也负责收尾删根。 */
  env: NativeExecutionEnv
  root: string
  repo: PiSessionRepo
  metadata: JsonlSessionMetadata
  /** 折叠前的盘上全文。 */
  before: string
  /** 折叠后的盘上全文。 */
  after: string
  /** 折叠前 / 折叠后的盘上真实字节（`fileInfo`）。 */
  bytesOnDiskBefore: number
  bytesOnDiskAfter: number
  /** 只可能是 folded：夹具在 skipped 时直接判失败（没有折叠就没有「折叠前后」）。 */
  outcome: Extract<FoldOutcome, { kind: "folded" }>
  expectDropped: string[]
  expectKept: { line: string; why: string }[]
}

async function buildFoldFixture(): Promise<FoldFixture> {
  const context = BACKGROUND_CONTEXT
  const env = new NativeExecutionEnv(await runtimePath("data"))
  const root = await runtimePath("data", `fold-${crypto.randomUUID()}`)
  const repo = await createPiSessionRepo({ sessionsRoot: root })
  try {
    // ① 真仓库 create + 真分支提交造条目：entry 行的 id / seq / parentId / timestamp 全部来自
    //    真实提交（`appendToBranch` 落的正是「entry + branch tip set」的多写事务）。
    const session = await repo.create({ id: "fold-probe" }, context)
    const lane = (await session.branch(PI_LANE, context)) ?? (await session.createBranch(PI_LANE, null, context))
    let lastEntryId = ""
    for (let index = 0; index < ENTRY_COUNT; index++) {
      // 偶数条 ASCII 载荷、奇数条中文载荷：字符数相同、字节数差 3 倍。
      const pad = index % 2 === 0 ? "x".repeat(ENTRY_PAD_CHARS) : "田".repeat(ENTRY_PAD_CHARS)
      lastEntryId = await lane.appendCustomEntry("fold-probe", { index, pad }, context)
    }
    await session.close(context)
    // 先关句柄、再冲帧缓冲（与 releasePiSession 同序）：折叠的前置条件之一是「没有写入者」。
    await flushSessionFrameWrites(context)

    // ② raw append：读一次盘上高水位定 seq，整段一次落盘（一次 IPC，不是几百次小写）。
    const path = session.metadata.path
    const raw = buildRawFixture(maxSeqOf(expectOk(await env.readTextFile(path, context), "readTextFile(高水位)")) + 1, lastEntryId)
    expectOk(await env.appendFile(path, raw.text, context), "appendFile(夹具正文)")
    const before = expectOk(await env.readTextFile(path, context), "readTextFile(before)")

    // ③ 折叠（与 `open` 前的兜底挂点是同一个驱动函数），前后各记一次盘上真实字节。
    const bytesOnDiskBefore = expectOk(await env.fileInfo(path, context), "fileInfo(before)").size
    const outcome = await repo.foldSession(session.metadata, context)
    // 夹具必须真的折叠：没有折叠就没有「折叠前后」可言，后面的断言会退化成比较同一份没变过的数据。
    expect(outcome.kind, `夹具应当产生一次真实折叠，实际 ${outcome.kind === "skipped" ? `skipped(${outcome.reason})` : "?"}`).toBe("folded")
    if (outcome.kind !== "folded") throw new Error("夹具应当产生一次真实折叠")
    const after = expectOk(await env.readTextFile(path, context), "readTextFile(after)")
    const bytesOnDiskAfter = expectOk(await env.fileInfo(path, context), "fileInfo(after)").size

    return {
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

async function disposeFoldFixture(fixture: FoldFixture): Promise<void> {
  const context = BACKGROUND_CONTEXT
  // 收尾失败不掩盖调用方的失败：这里只是把临时根删掉，根因留痕在用例失败报告。
  await fixture.repo.close(context).catch(() => undefined)
  await fixture.env.remove(fixture.root, { recursive: true, force: true }, context).catch(() => undefined)
}

// ── S-6 的探针：只改 header 一个字段 ──

/**
 * 版本探针的正文：与夹具同形的帧 append 行铺到**超过闸门 1** 的体积。
 *
 * 这一步不能省：文件没过闸门 1 时 `foldSessionFile` 在读正文之前就掉头，S-6 的断言会退化成
 * 「小文件不折叠」，与本覆盖点无关。探针文件不回给上游 open，因此 seq 从 1 起。
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

describe("会话日志折叠", () => {
  it("会话 JSONL 的纯删除式折叠：只删不增、保留行逐字不变、entryId 与 seq 不变、已删 key 的 append 全部回收、版本不匹配跳过 [harness-session-log-fold]", async () => {
    const context = BACKGROUND_CONTEXT
    const fixture = await buildFoldFixture()
    try {
      // ── ① S-4：可回收的整行真的被回收，且行级账目与夹具分类精确一致 ──
      {
        // 折叠真的发生过由夹具保证（builder 里断言过 folded；skipped 会直接判失败）。
        const { outcome, after, before } = fixture

        // 字节账目 = 盘上真实文件字节（UTF-8 口径）：只按 String.length 计数的实现在中文
        // 载荷上会差出 2 倍以上，这一条就是它的出口。
        expect(outcome.bytesBefore, "折叠前字节与盘上文件不符").toBe(fixture.bytesOnDiskBefore)
        expect(outcome.bytesAfter, "折叠后字节与盘上文件不符").toBe(fixture.bytesOnDiskAfter)
        expect(byteLength(before), `夹具的中文载荷不足：${byteLength(before)} B / ${before.length} 字符，字节口径无从区分`).toBeGreaterThanOrEqual(
          before.length * MIN_BYTES_PER_CHAR,
        )

        // 闸门 2 的两条下界都真的被跨过（夹具按 FOLD_POLICY 反推，不是碰巧过的）。
        const reclaimed = outcome.bytesBefore - outcome.bytesAfter
        expect(reclaimed, `回收 ${reclaimed} B < minReclaimBytes ${FOLD_POLICY.minReclaimBytes} B：夹具没过闸门 2`).toBeGreaterThanOrEqual(
          FOLD_POLICY.minReclaimBytes,
        )
        expect(reclaimed, `回收比例未过 minReclaimRatio ${FOLD_POLICY.minReclaimRatio}`).toBeGreaterThanOrEqual(
          outcome.bytesBefore * FOLD_POLICY.minReclaimRatio,
        )

        // 量化验收线：只断「变小」的话 1 字节的收益也能过。
        expect(outcome.bytesAfter, `折叠后没有变小：${outcome.bytesBefore} → ${outcome.bytesAfter}`).toBeLessThan(outcome.bytesBefore)
        expect(
          outcome.bytesAfter,
          `回收不足：${outcome.bytesAfter} / ${outcome.bytesBefore} > ${MAX_ACCEPTED_SIZE_RATIO}`,
        ).toBeLessThanOrEqual(outcome.bytesBefore * MAX_ACCEPTED_SIZE_RATIO)

        // 行级账目：删掉的整行**恰好**是夹具标为可回收的那些 —— 不多删（误删活 key 的写）也不少删。
        expect(outcome.droppedLines, `删除行数 ≠ 夹具可回收行数 ${fixture.expectDropped.length}`).toBe(
          fixture.expectDropped.length,
        )
        expect(outcome.linesAfter, `行数没有减少：${outcome.linesBefore} → ${outcome.linesAfter}`).toBeLessThan(
          outcome.linesBefore,
        )

        // 被删 key 的全部 append 行在折叠后的文本里零命中。
        for (const line of fixture.expectDropped) {
          expect(after.includes(line), `可回收的 append 行仍在折叠结果里：${line.slice(0, 120)}…`).toBe(false)
        }

        // 保留探针逐字在盘上（delete 行、被删 key 之后又 append 的那一行、多写行）。
        for (const probe of fixture.expectKept) {
          expect(after.includes(`${probe.line}\n`), `应逐字保留的行不在折叠结果里（${probe.why}）：${probe.line.slice(0, 120)}…`).toBe(true)
        }
      }

      // ── ② S-2：只删不增 —— 保留行是原文子串、行序不变、header 原样、仍以换行收尾 ──
      {
        const beforeLog = readFoldLog(fixture.before)
        const afterLog = readFoldLog(fixture.after)
        expect(afterLog.torn, "折叠结果以不完整的尾行结束（原文是完整行文件）").toBe(false)
        expect(fixture.after.endsWith("\n"), "折叠结果没有以换行结尾").toBe(true)
        expect(afterLog.headerLine, "header 行被改写了").toBe(beforeLog.headerLine)
        expect(fixture.after.startsWith(`${beforeLog.headerLine}\n`), "折叠结果不是以 header 行开头").toBe(true)

        const beforeLines = [beforeLog.headerLine, ...beforeLog.lines]
        const afterLines = [afterLog.headerLine, ...afterLog.lines]
        expect(afterLines.length, `折叠没有减少行数：${beforeLines.length} → ${afterLines.length}`).toBeLessThan(beforeLines.length)

        // ① 每一行都能在折叠前的文本里按行边界逐字找到（不是子串巧合）。
        for (const line of afterLines) {
          expect(fixture.before.includes(`${line}\n`), `折叠结果里的行不是原文的子串：${line.slice(0, 120)}…`).toBe(true)
        }

        // ② 折叠前的行序是折叠后的子序列 —— 没有重排、没有新造行。
        let cursor = 0
        for (const line of afterLines) {
          while (cursor < beforeLines.length && beforeLines[cursor] !== line) cursor += 1
          expect(cursor, `折叠结果的行序不是原文的子序列：${line.slice(0, 120)}…`).toBeLessThan(beforeLines.length)
          cursor += 1
        }
      }

      // ── ③ S-3：entry 行逐字不动（id / seq / parentId / timestamp），也不出现新的 seq ──
      {
        const beforeEntries = entryWritesOf(fixture.before)
        const afterEntries = entryWritesOf(fixture.after)
        expect(beforeEntries.length, "夹具里没有 entry 行：这条断言会退化成空比较").toBeGreaterThan(0)

        const beforeJson = JSON.stringify(beforeEntries)
        const afterJson = JSON.stringify(afterEntries)
        expect(
          afterJson,
          `entry 集合被改动了（共 ${beforeEntries.length} → ${afterEntries.length} 条）：\n前 ${beforeJson.slice(0, 240)}…\n后 ${afterJson.slice(0, 240)}…`,
        ).toBe(beforeJson)

        const knownSeqs = new Set(seqsOf(fixture.before))
        for (const seq of seqsOf(fixture.after)) {
          expect(knownSeqs.has(seq), `折叠后出现了折叠前不存在的 seq: ${seq}`).toBe(true)
        }
      }

      // ── ④ S-1：折叠前后重放出的逻辑状态摘要相同（驱动落盘的正是同一个摘要）──
      {
        const beforeDigest = await logStateDigest(readFoldLog(fixture.before))
        const afterDigest = await logStateDigest(readFoldLog(fixture.after))
        expect(afterDigest, `折叠前后逻辑状态摘要不一致：\n前 ${beforeDigest}\n后 ${afterDigest}`).toBe(beforeDigest)
        if (fixture.outcome.kind === "folded") {
          expect(fixture.outcome.digest, "驱动报告给调用方的摘要与场景独立重算的不一致").toBe(afterDigest)
        }
      }

      // ── ⑤ S-6：header 版本不在白名单内 ⇒ 跳过，且文件逐字未动 ──
      {
        const headerLine = readFoldLog(fixture.before).headerLine
        const header = JSON.parse(headerLine) as Record<string, unknown>
        const padding = versionProbePadding()

        // 差分对照（纯函数，不碰盘）：同一份正文配真 header 时结论是「没有整行可回收」，
        // 说明下面两个探针「文件没被动过」的成因确实是 header 版本，而不是正文不可折叠。
        const withRealHeader = prepareFold(readFoldLog(`${headerLine}\n${padding}`))
        expect(withRealHeader, "对照用的真 header 正文应当只是没有可回收行").toEqual({ kind: "skip", reason: "nothing-to-reclaim" })

        // 变体 A：storageVersion 不是本层白名单里的那一个（上游升版本）。
        // 变体 B：JSONL 格式版本不是 4（包导出面上没有格式版本常量，与实现里硬编码 4 同因）。
        const mutations: { path: string; header: Record<string, unknown> }[] = [
          { path: `${fixture.root}/fold-version-ahead.jsonl`, header: { ...header, storageVersion: JSONL_STORAGE_VERSION + 1 } },
          { path: `${fixture.root}/fold-format-behind.jsonl`, header: { ...header, v: 3 } },
        ]

        for (const mutation of mutations) {
          const content = `${JSON.stringify(mutation.header)}\n${padding}`
          expectOk(await fixture.env.writeFile(mutation.path, content, context), `writeFile(${mutation.path})`)
          const result = await foldSessionFile(fixture.env, mutation.path, context)
          expect(result, `版本不匹配应当 skip(unknown-format)`).toEqual({ kind: "skipped", reason: "unknown-format" })
          // 功能不受影响在存储层的可观测形态：文件一个字节都没被碰过。
          expect(await expectOk(await fixture.env.readTextFile(mutation.path, context), "readTextFile(探针)"), `版本不匹配时文件被改动了: ${mutation.path}`).toBe(content)
          // 探针必须真的超过闸门 1，否则上面跳过的是闸门 1 而不是 header 判定。
          const size = expectOk(await fixture.env.fileInfo(mutation.path, context), "fileInfo(探针)").size
          expect(size, `探针文件 ${size} B 没超过 minFileBytes ${FOLD_POLICY.minFileBytes} B：断言退化成了闸门 1`).toBeGreaterThan(
            FOLD_POLICY.minFileBytes,
          )
        }
      }

      // ── ⑥ 幂等：同一个文件再折一次，磁盘上一个字节都不会动 ──
      {
        const second = await fixture.repo.foldSession(fixture.metadata, context)
        expect(second.kind, `第二次折叠不应再重写文件，实际 ${JSON.stringify(second)}`).toBe("skipped")
        if (fixture.outcome.kind === "folded") {
          const expectedReason = fixture.outcome.bytesAfter <= FOLD_POLICY.minFileBytes ? "probe-too-small" : "nothing-to-reclaim"
          expect(second.kind === "skipped" ? second.reason : undefined, `第二次折叠的跳过原因应为 ${expectedReason}`).toBe(expectedReason)
        }

        // ① 盘上全文逐字未变。
        expect(await expectOk(await fixture.env.readTextFile(fixture.metadata.path, context), "readTextFile(第二次折叠后)"), "第二次折叠改动了文件").toBe(
          fixture.after,
        )
        const size = expectOk(await fixture.env.fileInfo(fixture.metadata.path, context), "fileInfo(第二次折叠后)").size
        expect(size, `第二次折叠后字节变了：${fixture.bytesOnDiskAfter} → ${size}`).toBe(fixture.bytesOnDiskAfter)

        // ② 与体积无关的等价判据：即使文件大到能过闸门 1，也已经没有整行可回收。
        const replan = prepareFold(readFoldLog(fixture.after))
        expect(replan, `折叠结果里仍有可回收的整行: ${JSON.stringify(replan).slice(0, 200)}`).toEqual({
          kind: "skip",
          reason: "nothing-to-reclaim",
        })
      }
    } finally {
      await disposeFoldFixture(fixture)
    }
  })
})

// ── 尺寸守卫：>5 MiB 的会话仍会折叠；只有「折叠结果」超写上限才不折 ──

/**
 * 主证据用例的文件目标体积：必须真的越过写侧的 5 MiB（`MAX_TOOL_FILE_BYTES`）。
 * 旧实现把这个写上限误用作读上限 —— 文件一超 5 MiB 就 skip("too-large")、永远折不动；
 * 修好后同一条夹具必须折成功（红 → 绿）。
 */
const OVER_WRITE_LIMIT_TARGET_BYTES = MAX_TOOL_FILE_BYTES + 512 * 1024

/**
 * 大体积夹具一帧的填充字符数：约 24 KiB UTF-8 / 行，5 MiB 量级只需数百行 ——
 * 主夹具的 120 字符/帧是为「字符数相同、字节数分叉」服务的，不适用于这里。
 */
const LARGE_FRAME_PAD_CHARS = 8 * 1024

/** 分段 append 的每段上限：低于单次 `file_append` 的 5 MiB 上限，并保证任一行独占一段时不越界。 */
const APPEND_CHUNK_BYTES = 4 * 1024 * 1024

/**
 * 解包 folded 结果（夹具解码器，与 `expectOk` 同类，不是第二层断言）：skipped 时先经 expect 记一条
 * 带 reason 的失败，再中止本用例 —— 没有折叠就没有后面的字节账目可言。
 */
function expectFolded(outcome: FoldOutcome, label: string): Extract<FoldOutcome, { kind: "folded" }> {
  expect(
    outcome.kind,
    `${label}: ${outcome.kind === "skipped" ? `skipped(${outcome.reason})` : outcome.kind}`,
  ).toBe("folded")
  if (outcome.kind !== "folded") throw new Error(`${label}: 期望 folded`)
  return outcome
}

/** 大体积夹具一帧的载荷：形状与 `framePayload` 相同（thinking_delta），只有填充长度可调。 */
function largeFramePayload(prefix: string, index: number): { type: "thinking_delta"; contentIndex: number; delta: string } {
  return { type: "thinking_delta", contentIndex: 0, delta: `帧-${prefix}-${index}-${"田".repeat(LARGE_FRAME_PAD_CHARS)}` }
}

interface SizeGuardFixture {
  env: NativeExecutionEnv
  root: string
  repo: PiSessionRepo
  metadata: JsonlSessionMetadata
  path: string
  /** 折叠前的盘上真实字节（`fileInfo`）。 */
  bytesOnDisk: number
  /** 死 key 帧行（折叠的全部回收来源）的行数与总字节（含行尾换行）。 */
  droppedLineCount: number
  droppableBytes: number
  /** 可回收行的首尾样本（折叠后必须零命中）与保留行的样本（必须逐字在）。 */
  droppedSample: string[]
  keptSample: string[]
}

/**
 * 尺寸守卫夹具：真仓库造条目 + raw append 造「死 key 帧段（+ delete）与活 key 帧段」。
 *
 * 与主夹具同一套行构造手法（`rawLine` + 上游构造器 + 盘上高水位 seq），只有两点是「必须超过
 * 5 MiB」逼出来的：① 夹具根放在 `sessions/` 域内 —— 会话根内的读走宿主 `session_read_text`
 * （无单次大小上限），与生产一致；放在域外会退回 `file_read`（MAX_TOOL_FILE_BYTES 上限），
 * 夹具阶段就读不动了；② 整段按 APPEND_CHUNK_BYTES 分段 append（单次 file_append 写不下 5 MiB）。
 */
async function buildSizeGuardFixture(options: {
  id: string
  droppableTargetBytes: number
  keptTargetBytes: number
}): Promise<SizeGuardFixture> {
  const context = BACKGROUND_CONTEXT
  const env = new NativeExecutionEnv(await runtimePath("data"))
  const root = await runtimePath("sessions", `fold-size-${crypto.randomUUID()}`)
  const repo = await createPiSessionRepo({ sessionsRoot: root })
  try {
    const session = await repo.create({ id: options.id }, context)
    const lane = (await session.branch(PI_LANE, context)) ?? (await session.createBranch(PI_LANE, null, context))
    await lane.appendCustomEntry("fold-size-guard", { id: options.id }, context)
    await session.close(context)
    // 先关句柄、再冲帧缓冲（与主夹具同序）：折叠的前置条件之一是「没有写入者」。
    await flushSessionFrameWrites(context)

    const path = session.metadata.path
    let seq = maxSeqOf(expectOk(await env.readTextFile(path, context), "readTextFile(高水位)")) + 1
    const timestamp = Date.now()
    const lines: string[] = []

    // ① 死 key：整段帧 append + 一条 list/delete ⇒ 全部帧行「确定可丢」（折叠的主回收来源）。
    const dead = pendingAssistantFrames("op-fold-size-dead", "resp-fold-size-dead")
    let droppedLineCount = 0
    let droppableBytes = 0
    let deadFirst = ""
    let deadLast = ""
    for (let index = 0; droppableBytes < options.droppableTargetBytes; index++) {
      const line = rawLine([appendList(dead, largeFramePayload("op-fold-size-dead", index))], seq, timestamp)
      lines.push(line)
      if (droppedLineCount === 0) deadFirst = line
      deadLast = line
      droppedLineCount += 1
      droppableBytes += byteLength(line) + 1
      seq += 1
    }
    const deleteLine = rawLine([deleteList(dead)], seq, timestamp)
    lines.push(deleteLine)
    seq += 1

    // ② 活 key（主证据用例传 0）：从未 delete ⇒ 行行保留，用来把「折叠结果」撑过写上限。
    const live = pendingAssistantFrames("op-fold-size-live", "resp-fold-size-live")
    let keptBytes = 0
    let liveFirst = ""
    for (let index = 0; keptBytes < options.keptTargetBytes; index++) {
      const line = rawLine([appendList(live, largeFramePayload("op-fold-size-live", index))], seq, timestamp)
      lines.push(line)
      if (liveFirst === "") liveFirst = line
      keptBytes += byteLength(line) + 1
      seq += 1
    }

    // ③ 分段 append：单次 file_append 的上限是 MAX_TOOL_FILE_BYTES（5 MiB），整段一次写不下。
    let pending: string[] = []
    let pendingBytes = 0
    const flushChunk = async (): Promise<void> => {
      if (pending.length === 0) return
      expectOk(await env.appendFile(path, `${pending.join("\n")}\n`, context), "appendFile(夹具分段)")
      pending = []
      pendingBytes = 0
    }
    for (const line of lines) {
      const lineBytes = byteLength(line) + 1
      if (pendingBytes + lineBytes > APPEND_CHUNK_BYTES) await flushChunk()
      pending.push(line)
      pendingBytes += lineBytes
    }
    await flushChunk()

    const bytesOnDisk = expectOk(await env.fileInfo(path, context), "fileInfo(before)").size
    return {
      env,
      root,
      repo,
      metadata: session.metadata,
      path,
      bytesOnDisk,
      droppedLineCount,
      droppableBytes,
      droppedSample: [deadFirst, deadLast],
      keptSample: [deleteLine, ...(liveFirst === "" ? [] : [liveFirst])],
    }
  } catch (error) {
    // 建夹失败也要把临时根收掉：根因是这里抛出的那个，收尾失败不再叠加一层。
    await repo.close(context).catch(() => undefined)
    await env.remove(root, { recursive: true, force: true }, context).catch(() => undefined)
    throw error
  }
}

async function disposeSizeGuardFixture(fixture: SizeGuardFixture): Promise<void> {
  const context = BACKGROUND_CONTEXT
  // 收尾失败不掩盖调用方的失败：这里只是把临时根删掉，根因留痕在用例失败报告。
  await fixture.repo.close(context).catch(() => undefined)
  await fixture.env.remove(fixture.root, { recursive: true, force: true }, context).catch(() => undefined)
}

describe("会话日志折叠 · 尺寸守卫", () => {
  it("会话文件超过 5 MiB 写上限仍会折叠：读路径无单次大小上限，折叠结果落在写上限内即落盘 [harness-session-fold-read-guard]", async () => {
    const context = BACKGROUND_CONTEXT
    const fixture = await buildSizeGuardFixture({
      id: "fold-size-over",
      droppableTargetBytes: OVER_WRITE_LIMIT_TARGET_BYTES,
      keptTargetBytes: 0,
    })
    try {
      // 主证据：文件真的超过 5 MiB。旧守卫（写上限误用于读侧）在这一步就 skip("too-large")，
      // 下面的 folded 断言会红；修好后同一条夹具必须折成功。
      expect(
        fixture.bytesOnDisk,
        `夹具未超过 MAX_TOOL_FILE_BYTES（${MAX_TOOL_FILE_BYTES} B，实际 ${fixture.bytesOnDisk} B）：本用例失去区分力`,
      ).toBeGreaterThan(MAX_TOOL_FILE_BYTES)

      const outcome = expectFolded(await fixture.repo.foldSession(fixture.metadata, context), ">5 MiB 的会话文件折叠")

      expect(outcome.bytesBefore, "折叠前字节与盘上文件不符").toBe(fixture.bytesOnDisk)
      expect(outcome.droppedLines, "删掉的整行数 ≠ 夹具的死 key 帧行数").toBe(fixture.droppedLineCount)
      expect(outcome.bytesAfter, "折叠结果必须落在写上限内").toBeLessThanOrEqual(MAX_TOOL_FILE_BYTES)

      const sizeAfter = expectOk(await fixture.env.fileInfo(fixture.path, context), "fileInfo(after)").size
      expect(sizeAfter, "落盘字节 ≠ 折叠结果字节").toBe(outcome.bytesAfter)

      // 内容对照（折叠后已低于 5 MiB，可直接读回）：可回收行零命中、delete 行逐字保留。
      const after = expectOk(await fixture.env.readTextFile(fixture.path, context), "readTextFile(after)")
      for (const line of fixture.droppedSample) {
        expect(after.includes(line), `可回收的帧行仍在折叠结果里：${line.slice(0, 120)}…`).toBe(false)
      }
      for (const line of fixture.keptSample) {
        expect(after.includes(`${line}\n`), `应逐字保留的行不在折叠结果里：${line.slice(0, 120)}…`).toBe(true)
      }
    } finally {
      await disposeSizeGuardFixture(fixture)
    }
  })

  it("折叠结果仍超过 5 MiB 写上限时保持不折：skipped(too-large)，磁盘逐字未动 [harness-session-fold-result-guard]", async () => {
    const context = BACKGROUND_CONTEXT
    // 死 key 1.5 MiB（过闸门 2 的两条下界）+ 活 key 超过 5 MiB（折叠结果仍超写上限）。
    const fixture = await buildSizeGuardFixture({
      id: "fold-size-still-over",
      droppableTargetBytes: FOLD_POLICY.minReclaimBytes * 12,
      keptTargetBytes: OVER_WRITE_LIMIT_TARGET_BYTES,
    })
    try {
      expect(fixture.bytesOnDisk, `夹具未超过写上限：${fixture.bytesOnDisk} B`).toBeGreaterThan(MAX_TOOL_FILE_BYTES)
      expect(
        fixture.bytesOnDisk,
        `夹具必须低于 FOLD_POLICY.maxFileBytes（${FOLD_POLICY.maxFileBytes} B），否则跳过的是读取守卫而不是结果守卫`,
      ).toBeLessThan(FOLD_POLICY.maxFileBytes)
      // 回收量确实过闸门 2 —— 否则 skip 的原因会是 nothing-to-reclaim，这条用例就证不到结果守卫。
      expect(fixture.droppableBytes, "夹具可回收量未过闸门 2（绝对值）").toBeGreaterThanOrEqual(FOLD_POLICY.minReclaimBytes)
      expect(fixture.droppableBytes, "夹具可回收量未过闸门 2b（比例）").toBeGreaterThanOrEqual(
        fixture.bytesOnDisk * FOLD_POLICY.minReclaimRatio,
      )

      const outcome = await fixture.repo.foldSession(fixture.metadata, context)
      expect(outcome, "折叠结果超过写上限时不得落盘（结果守卫必须保留）").toEqual({ kind: "skipped", reason: "too-large" })

      const sizeAfter = expectOk(await fixture.env.fileInfo(fixture.path, context), "fileInfo(after)").size
      expect(sizeAfter, "被跳过时磁盘不应被改动").toBe(fixture.bytesOnDisk)
    } finally {
      await disposeSizeGuardFixture(fixture)
    }
  })
})
