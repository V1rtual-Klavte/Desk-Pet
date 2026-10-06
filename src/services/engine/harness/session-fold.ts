// ==========================================
// 会话 JSONL 日志的纯删除式折叠：log → log'（执行方案 W5：T5.00 折叠核心 + T5.01 状态摘要；源方案 §7.1 方案一）
//
// 会话文件是 append-only：帧（`pi.pending.assistant_frame`）的每次流式增量追加一行，而
// `list/delete` / `value/delete` 只追加一条删除记录 —— 被删 key 的历史 append 不会从盘上
// 消失（W1 的帧节流只降写入频率，不动体积）。折叠把「确定可丢」的整行**纯删除**掉，是
// write + rename 之外唯一的物理回收手段。
//
// D3 残余成本（2026-09-27 登记；用户裁定「有意接受（够用）」，**不追加任务**；不得误读为已解决）：
//   · 折叠**只解决体积，不解决读取复杂度**：它把实测文件 792,898 → 293,879 字节，于是
//     `JsonlStorage.open` 的「全量读 + 逐行重放」（`storage.js:114-146`）少读 62.9% 的字节、
//     少重放 94.9% 的行（2,187 → 112），**但仍然是 O(全文件)**；残量 245,126 字节是**正文条目**
//     （真相源本身），删不掉。
//   · 接受的理由（三条）：(a) 残量的主体就是真相源本身，任何进一步的压缩都只能改「真相源怎么
//     存」，那是另一个量级的决定；(b) `readTextLines({maxLines})` 这条路**对 open 无效** —— open
//     必须拿到全部行才能重放出完整状态，分块读只会把一次读变成 N 次读；能受益的只有 `list`，而
//     它**已经**在用 `{maxLines: 1}`（`jsonl/repo.js:194`）；(c) 真要解 D3 只有两条路：把日志换成
//     「快照 + 增量」（上游 header 的 `nextSeq` 注释已暗示存在这种重写，`jsonl/types.d.ts:14`），
//     或请上游支持增量打开 —— **两条都超出源方案范围**，前者正是源方案 §7.1 `:366` 明确否决的
//     「全量折叠」（需要重新生成 seq）。
//   · 将来若会话规模真的上来，周期状态快照是明确的下一个候选 —— 届时应**另立方案**，不是本执行
//     的追加任务。
//   · **规则扩展已落地（2026-10-06，用户拍板方案①「同一 key 只保留最后一次写入」）**：此前只回收
//     「最后一次 delete 之前」的写入，被反复覆盖但**从未 `delete`** 的 `value/set`（实测参考会话
//     4 个 key、144 条写入：`pi.lane.config` 43 / `pi.lane.state` 51 / `pi.branch.tip` 48 /
//     `pi.session.name` 2）碰不到 ⇒ 这类会话的可回收量恒小于 `minReclaimBytes`，闸门 2 永远拒绝
//     折叠，而文件仍会越过 `minFileBytes`，每次 close/open 前都**白做一次 stat**。现在规则扩成
//     「同一 **value** key 只保留最后一次 `set`」：行号严格小于该 key 最后一次 `value/set` 的 set
//     可丢。scalar 是覆盖语义（重放里 `scalarValues.set` 只留最后一个 `{seq, value}`），因此
//     replay 等价性证明与状态摘要校验都不变；S-2「保留行逐字不变」也不变（仍是整行纯删除）。
//     实测动机：旧大会话里三条各 2.4 MB 的 `pi.op.preparation`（`value/set`）与保留写入同行被
//     钉死 7.2 MB —— 同行两侧现在都能作为「非最后一次写入」整行回收。
//   · **`list/append` 不适用这条扩展**（有意收窄）：list 的 append 在重放里累积成**元素序列**
//     （`listValues`，元素顺序是语义），丢任何一条都会改变逻辑状态、摘要必然不一致 —— 它不是
//     「同一 key 只保留最后一次写入」的适用对象；它的回收来源仍是「最后一次 delete 之前的整段」。
//   · **成功折叠不可逆**：被删行的原字节随 rename 覆盖消失，**不保留 `.bak`、没有回滚路径**；
//     安全防线只有「提交前的状态摘要比对 + 原子替换」，且这两条只在**失败**时保住原文件。
//
// 判定规则（只删 append/set，delete 行本身永远保留）：
//   · `list`  key = namespace + U+0000 + key：设 d = 该 key **最后一次** `list/delete` 的行号，
//     行号 < d 的 `list/append` 可丢；行号 ≥ d 的写入（含 d 自己）一律保留。
//   · `value` key：设 d = 最后一次 `value/delete` 的行号、s = 最后一次 `value/set` 的行号，
//     行号 < max(d, s) 的 `value/set` 可丢 —— 即「d 之前」或「s 之前」两者居其一：
//       · d 之前的写被 delete 抹掉（重放 delete 直接删表项，与它前面写过什么无关）；
//       · s 之前的写被更后的 set 覆盖（`scalarValues` 是覆盖语义，重放只留最后一个 set）。
//     seq 在文件里严格递增（上游 validateCommittedWrites 拒绝非递增），被丢的 set 不可能是
//     seq 最大值 ⇒ `nextSeq` 高水位不受影响（重放取 max(seq)+1）。
//   · `list/append` **没有**「只保留最后一次写入」形态（理由见文件头）。
//   ⇒ replay(原日志) === replay(折叠后日志)：对不存在的 key 做 delete 与「append 一堆再 delete」
//     终态相同；只丢「最后一次 delete 之前」或「最后一次 set 之前」的写入，保证「先 delete 后
//     又被 append/set」的 key 不被误判为死 key（执行方案 §1.9 实测该形态出现 0 次，但折叠器
//     **不假定**它，必须运行时检查）。
//
// 三条硬性质（源方案 §8.5）：
//   S-2 只删不增、保留行逐字不变 —— 构造性成立：输出 = header 原文 + 保留行原文的换行连接，
//       本文件从不重新序列化任何保留行（全文没有一处 JSON 重序列化调用）。
//   S-3 不改变任何 entryId 与 seq —— entry/usage 行一个不动，也不新增写入，不需要重编号，
//       header 里的 nextSeq 高水位原样保留。
//   X-1 entry 集合不变 ⇒ 折叠前后展示地址（shortenAddresses 的取值）逐字相同。
//
// 第四条是**可验证性**（源方案 §7.1「折叠安全要求 3」= S-1，T5.01 交付）：把「折叠前后逻辑状态
// 完全等价」变成可执行、可留痕的检查 —— replayLogState 从日志文本重放出完整逻辑状态，
// logStateDigest 给出稳定摘要，**两侧摘要必须相同**：
//   · 摘要（SHA-256 over UTF-8）只依赖逻辑状态：行序、行数、字节数、行排版都不参与 —— 这些正是
//     折叠必然改变的东西，掺进去会让校验恒失败（字段表见 LogState）。
//   · **先算后写**（顺序写死）：先算原日志摘要、再算折叠结果摘要，一致才允许落盘。不一致时
//     磁盘上什么都没发生、原文件保持原样，调用方返回 skip("hash-mismatch") 并 warn 留痕
//     （含两侧摘要与统计；驱动见 T5.02 的 foldSessionFile）。
//   · **诚实边界（不许当成唯一防线）**：两侧用的是本模块自己的重放，若重放本身抄错了上游
//     `InMemoryStorageState.applyValidated` 的语义，两侧会「一致地错」。所以它必须与上面那条
//     局部判据（只丢「该 key 最后一次 delete 之前」的写入）以及 T5.07 的逐字比对**同时存在** ——
//     两条一起才有意义，不允许只保留其中一条。
//
// 单位口径（本波唯一的单位陷阱）：字节一律是 **UTF-8 字节**（TextEncoder），与 Rust 侧
// `file_write` 判上限用的 `content.len()` 同口径；禁用 `String.length`（UTF-16 长度，中文
// 内容下差约 3 倍，且 ASCII 夹具查不出来）。
//
// 上游耦合（O-8 的登记点）：白名单逐条对齐 `harness/session/jsonl/storage.js:20-45`
// （parseCommittedWrite）与 `commit.js:7-22`（commitWrite）；`v: 4` 来自 `jsonl/types.d.ts:3`；
// 重放逐条对齐 `harness/session/in-memory-storage-state.js:53-108`（applyValidated）与
// `storage.js:141-142`（header.nextSeq 取 max）。
// 上游 `storageVersion` 升级 ⇒ 先看 `pnpm run test:types` 的绊线报错，再按 `jsonl/storage.js:20-45`
// 重核白名单与「单写行 vs 数组行」的序列化规则（`storage.js:56-58`）；三层机制（编译期绊线 /
// 运行期 unknown-format 降级 / 人读登记）在 STORAGE_VERSION_GUARD 旁列全。
//
// 文件分两半，边界写死：
//   · 上半（readFoldLog / prepareFold / replayLogState / logStateDigest）是**纯函数**：不碰
//     FileSystem、无副作用、不落任何日志 —— 所有「不折叠」的结论都以 FoldSkipReason 返回给
//     调用方，没有一条失败被吞掉。
//   · 下半（T5.02 的 foldSessionFile）是**唯一驱动**：唯一碰 FileSystem、唯一留痕的地方
//     （createLogger("SessionFold")，等级按执行方案 T5.02 步骤 4 的表）。它读一次 → 判定 →
//     摘要校验 → 写同目录临时文件 → renameFile 覆盖；任何一步失败都保留原文件、返回 skipped，
//     绝不抛错、绝不影响会话功能。
// 外部依赖：上游的 `JSONL_STORAGE_VERSION`；`@/services/engine/runtime` 的 `sha256Text` /
// `stableSerialize`（`engine/runtime` 不 import `engine/harness`，不成环）；`@/services/logger` 与
// `@/services/error`（同目录的 `session-frame-buffer.ts` 已是同样的依赖方向）。
// ==========================================

import { JSONL_STORAGE_VERSION } from "@earendil-works/pi-agent-core/harness/session"
import type { Context, FileSystem } from "@earendil-works/pi-agent-core"
import { sha256Text, stableSerialize } from "@/services/engine/runtime"
import { SESSION_WRITE_MAX_BYTES } from "./session-file-system"
import { formatError } from "@/services/error"
import { createLogger } from "@/services/logger"

/**
 * 折叠策略（O-6 的裁定口径；本模块是这四个阈值的**唯一**定义点，不建大一统 constants 文件）。
 * 纯函数只负责算「可回收多少」，闸门由 T5.02 的 foldSessionFile 按文件大小与回收量施加。
 */
export const FOLD_POLICY = {
  /** 闸门 1：文件字节 ≤ 此值不探测（避免为小文件白读一次全文）。 */
  minFileBytes: 512 * 1024,
  /** 闸门 2：可回收字节低于此值不重写（重写自身有一次 write+rename 的成本与风险）。 */
  minReclaimBytes: 128 * 1024,
  /** 闸门 2b：可回收比例低于此值不重写。 */
  minReclaimRatio: 0.15,
  /**
   * 读取守卫：文件字节 > 此值不读不折。它是**折叠自愿设的上界**（读全文 + 两次重放 + 两次摘要
   * 都在 Node 里按体积放大），不是读路径的限制 —— 会话读路径没有单次大小上限，依据见
   * foldSessionFile 步骤 1 的注释。写侧的对应物是会话写路径的 SESSION_WRITE_MAX_BYTES
   * （session-file-system.ts，与它同值）：折叠只删不增 ⇒ 结果 ≤ 输入 ≤ 本值，读得到就写得回。
   */
  maxFileBytes: 64 * 1024 * 1024,
} as const

/**
 * 与上游 jsonl/storage.js 的 splitCompleteLines 同语义：尾行不完整则丢弃并置 torn。
 *
 * `lines` 只装**完整行**，因此撕裂文件的那半行既不参与判定、也不进入折叠结果 —— 与上游
 * 检测到撕裂后重写整个文件的口径一致（`storage.js:143-144`）。
 */
export interface FoldLog {
  /** 第一行原文（header），不解析、不修改。 */
  headerLine: string
  /** header 之后的完整行原文，index 0 对应文件第 2 行。 */
  lines: string[]
  /** 原文结尾有不完整行（会被上游 open 丢弃并重写）。 */
  torn: boolean
}

export type FoldSkipReason =
  /** header 不是 v4 + storageVersion 1；或某行不是合法事务。 */
  | "unknown-format"
  /** 整个文件一行都不可丢；或可回收字节未过闸门 2/2b（阈值判定在 T5.02 的驱动里）。 */
  | "nothing-to-reclaim"
  /** 原文超过 FOLD_POLICY.maxFileBytes、或折叠结果超过会话写上限 SESSION_WRITE_MAX_BYTES（由 T5.02 的驱动按各自上限产生，纯函数不看文件大小）。 */
  | "too-large"
  /** 折叠前后重放出的状态摘要不一致（S-1）：由 T5.02 的驱动产生，**此时不写任何文件**、原文件保持原样。 */
  | "hash-mismatch"

export type FoldPlan =
  | {
      kind: "fold"
      text: string
      /** 完整行数（含 header）；撕裂文件不含被丢弃的半行。 */
      linesBefore: number
      linesAfter: number
      droppedLines: number
      /** 被删掉的整行里包含的写入条数（数组行整行可丢时按该行的写入数计）。 */
      droppedWrites: number
      /** 完整行部分的 UTF-8 字节（非撕裂文件 = 文件字节数）。 */
      bytesBefore: number
      bytesAfter: number
    }
  | { kind: "skip"; reason: FoldSkipReason }

/** 阈值按**字节**计；口径与 Rust `file_write` 的 `content.len()`、W1 的帧缓冲一致。 */
const utf8Encoder = new TextEncoder()

function utf8ByteLength(text: string): number {
  return utf8Encoder.encode(text).byteLength
}

/**
 * 物理 key 的分隔符：上游用 U+0000 拼 `${namespace}\\u0000${key}`（`in-memory-storage-state.js:4-6`）。
 * 这里用 `String.fromCharCode(0)` 写死，避免源码里藏一个不可见的控制字符（下游要按文本 grep 本文件）。
 */
const ADDRESS_SEPARATOR = String.fromCharCode(0)

/**
 * `v`（JSONL 格式版本）没有出现在包的导出面上（`jsonl/types.d.ts:3` 是唯一真相源），只能在
 * 这里硬编码；`storageVersion` 用包导出的常量，升级时由 T5.02 的编译期绊线接住。
 */
const SUPPORTED_FORMAT_VERSION = 4

/**
 * 完整行文本的规范形状：`header\n…\n`（与上游 `storage.js:59-61` 的 serializeStorage 同形，
 * 含「一个事务都没有」时只留 `header\n`）。
 *
 * 折叠前用它度量 bytesBefore（非撕裂文件逐字节等于原文件），折叠后用它产出新正文 ——
 * 输出形状只有一个定义点。
 */
function serializeCompleteLines(headerLine: string, lines: readonly string[]): string {
  return lines.length === 0 ? `${headerLine}\n` : `${headerLine}\n${lines.join("\n")}\n`
}

function isSafeIntegerAtLeast(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
}

/**
 * 白名单解析的结果。判定（prepareFold）只关心 `role` 与 `physicalKey`；重放（replayLogState）
 * 还要 `raw`（按 kind 解构出整对象）与 `seq` —— 两者由同一次解析产出，白名单与 JSON 解析都
 * 只有一个定义点，重放不再自己解一遍日志。
 */
type ParsedWrite =
  | { role: "append"; seq: number; raw: Record<string, unknown>; physicalKey: string }
  | { role: "set"; seq: number; raw: Record<string, unknown>; physicalKey: string }
  | { role: "delete"; seq: number; raw: Record<string, unknown>; target: "list" | "value"; physicalKey: string }
  | { role: "keep"; seq: number; raw: Record<string, unknown> }

/**
 * 物理 key = namespace + ADDRESS_SEPARATOR + key（抄自上游 `in-memory-storage-state.js:4-6`）。
 *
 * namespace / key 缺失或不是字符串时返回 null ⇒ 整个文件 skip("unknown-format")：算不出 key
 * 就判不了「这个 key 死没死」，宁可少删不可误删（上游在**写入时**经 values.js 的 validateAddress
 * 保证这两字段存在，落盘的合法行必然有它们）。
 *
 * 注意 scalarValues 与 listValues 在上游是**两张独立的表**，同一个物理 key 串可以同时存在于
 * 两边，所以调用方不能把 list 与 value 的 delete 合并成一张表。
 */
function physicalKeyOf(write: Record<string, unknown>): string | null {
  const namespace = write.namespace
  const key = write.key
  if (typeof namespace !== "string" || typeof key !== "string") return null
  return `${namespace}${ADDRESS_SEPARATOR}${key}`
}

/**
 * 与上游 `storage.js:20-45` 的 parseCommittedWrite **逐条对齐**：不宽容任何未列出的
 * kind / op 组合，也不给缺失字段补默认值；对不上就返回 null ⇒ 整个文件 skip("unknown-format")。
 *
 * 必需字段只有「判定用得到的那几个」：所有 kind 都要 `seq` 为 ≥1 的安全整数；`entry` 还要
 * `timestamp` 为 ≥0 的安全整数；`value` / `list` 还要 namespace / key 为字符串。`value`
 * 字段本身不参与判定（上游在 value 为 undefined 时序列化会省略它），因此不作要求。
 */
function parseWrite(value: unknown): ParsedWrite | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const write = value as Record<string, unknown>
  if (!isSafeIntegerAtLeast(write.seq, 1)) return null
  switch (write.kind) {
    case "entry":
      return isSafeIntegerAtLeast(write.timestamp, 0) ? { role: "keep", seq: write.seq, raw: write } : null
    case "usage":
      return { role: "keep", seq: write.seq, raw: write }
    case "value":
    case "list": {
      const physicalKey = physicalKeyOf(write)
      if (physicalKey === null) return null
      if (write.op === "delete") return { role: "delete", seq: write.seq, raw: write, target: write.kind, physicalKey }
      // append 只属于 list、set 只属于 value；错配组合不在白名单里（storage.js:30-41）。
      if (write.op === "append" && write.kind === "list") return { role: "append", seq: write.seq, raw: write, physicalKey }
      if (write.op === "set" && write.kind === "value") return { role: "set", seq: write.seq, raw: write, physicalKey }
      return null
    }
    default:
      return null
  }
}

/**
 * 一行 = 一个事务：顶层是数组 = 批量事务，顶层是对象 = 单写（`storage.js:46-55`）。
 *
 * 返回 null 表示这一行不是本模块认得的合法事务。有意不在此留痕：解析失败不是被吞掉的失败，
 * 而是让整个文件走 skip("unknown-format") 并保持原样的判据，留痕由调用方（T5.02 的
 * foldSessionFile）按 unknown-format 的口径统一做。
 */
function parseTransaction(line: string): ParsedWrite[] | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  const rawWrites = Array.isArray(value) ? value : [value]
  const writes: ParsedWrite[] = []
  for (const raw of rawWrites) {
    const write = parseWrite(raw)
    if (write === null) return null
    writes.push(write)
  }
  return writes
}

/**
 * header 行的**唯一解析点**：可解析且是普通对象时返回该对象，否则 null（空串、JSON 失败、
 * 数组/标量都算「认不出」）。判定（parseSupportedHeader）与留痕（reportUnknownFormat 要拿
 * `storageVersion` 值做去重键）共用它，header 的形状知识不散成两处。
 *
 * 解析失败不是被吞掉的失败，而是让整个文件走 skip("unknown-format") 并保持原样的判据 ——
 * 留痕由调用方（T5.02 的 foldSessionFile）按 unknown-format 的口径统一做。
 */
function parseHeaderObject(headerLine: string): Record<string, unknown> | null {
  if (headerLine === "") return null
  let value: unknown
  try {
    value = JSON.parse(headerLine)
  } catch {
    // 同上：不是被吞掉的失败，是 skip("unknown-format") 的判据（留痕在 foldSessionFile）。
    return null
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/**
 * header 必须是本模块认得的 v4 + `storageVersion: 1` 头；认得就返回 header 对象，否则 null。
 *
 * 空串 = 文件一个换行都没有（上游 splitCompleteLines 返回 `lines: []`，open 按「missing
 * header」拒绝，`storage.js:117-119`）；v3-legacy 头（`type: "session"` / `version: 3`）也在这里
 * 被挡下 —— 折叠只对 v1 的字段白名单成立，认不出就跳过（安全降级，不影响会话功能）。
 *
 * 返回对象而不是布尔：重放要从同一个 header 取 `nextSeq` 高水位，判定与取值共用这一次解析
 * （header 形状只有一个定义点）。
 */
function parseSupportedHeader(headerLine: string): Record<string, unknown> | null {
  const header = parseHeaderObject(headerLine)
  if (header === null) return null
  const supported =
    header.kind === "header" &&
    header.v === SUPPORTED_FORMAT_VERSION &&
    header.storageVersion === JSONL_STORAGE_VERSION
  return supported ? header : null
}

/**
 * 一条写是否「确定可丢」：只有 list/append 与 value/set 是候选。
 *
 *   · `append`：行号必须**严格小于**该 key 最后一次 `list/delete` 的行号。
 *   · `set`：行号必须严格小于 max(最后一次 `value/delete`, 最后一次同 key `value/set`) ——
 *     delete 之前的写被 delete 抹掉；非最后一次的写被更后的 set 覆盖（scalar 覆盖语义）。
 *
 * 「先 delete 后又 append/set」的 key 不被误判为死 key：revive 之后的写入行号必然 ≥ 最后一次
 * delete（append 因此一律不可丢）；其中 set 若被更晚的同 key set 覆盖，丢的是被覆盖的那条，
 * 终态仍由最后一条 set 决定（见 replayLogState 的覆盖语义）。
 */
function isDroppable(
  write: ParsedWrite,
  lineIndex: number,
  lastListDelete: ReadonlyMap<string, number>,
  lastValueDelete: ReadonlyMap<string, number>,
  lastValueSet: ReadonlyMap<string, number>,
): boolean {
  if (write.role === "append") {
    const lastDelete = lastListDelete.get(write.physicalKey)
    return lastDelete !== undefined && lineIndex < lastDelete
  }
  if (write.role === "set") {
    const lastDelete = lastValueDelete.get(write.physicalKey)
    const lastSet = lastValueSet.get(write.physicalKey)
    return (
      (lastDelete !== undefined && lineIndex < lastDelete) ||
      (lastSet !== undefined && lineIndex < lastSet)
    )
  }
  // entry / usage / delete 永远保留（delete 是重放等价的一半，丢它才会真改语义）。
  return false
}

/** 按上游 splitCompleteLines 语义切分；不解析 JSON。 */
export function readFoldLog(text: string): FoldLog {
  if (text.endsWith("\n")) {
    const lines = text.slice(0, -1).split("\n")
    return { headerLine: lines[0] ?? "", lines: lines.slice(1), torn: false }
  }
  const lastNewline = text.lastIndexOf("\n")
  if (lastNewline === -1) {
    // 整个文件一个换行都没有（外部截断）：上游返回 lines: []、torn: true（storage.js:66-68），
    // headerLine 因此落成空串，prepareFold 视同「无 header」直接跳过。
    return { headerLine: "", lines: [], torn: true }
  }
  const lines = text.slice(0, lastNewline).split("\n")
  return { headerLine: lines[0] ?? "", lines: lines.slice(1), torn: true }
}

/**
 * 计算可丢行并产出折叠文本。
 *
 * 判定（唯一规则，见文件头；d/s 都是**行号**）：
 *   · 对 list  key = namespace + U+0000 + key：设 d = 该 key 最后一次 `list/delete` 的行号；
 *     行号 < d 的 `list/append` 可丢；行号 ≥ d 的写入（含 d 自己）必须保留。
 *   · 对 value key：设 d = 最后一次 `value/delete`、s = 最后一次 `value/set` 的行号；
 *     行号 < max(d, s) 的 `value/set` 可丢（delete 抹掉 d 之前的、覆盖语义吃掉非最后的）。
 *
 * 行级粒度：**仅当一行里的全部写入都可丢时才删除该行**；一行里只要有一个保留写入，整行原样
 * 保留（不做重序列化、不重排）。header 行永远保留。任一行 JSON.parse 失败、或 kind/op 不在
 * 白名单、或缺少判定必需字段 ⇒ 返回 skip("unknown-format")，原文件不动。
 *
 * 一行都不可丢时返回 skip("nothing-to-reclaim")：调用方据此跳过重写（按阈值判断「这点回收量
 * 值不值得重写」是 T5.02 的闸门 2/2b，纯函数不掺和）。
 */
export function prepareFold(log: FoldLog): FoldPlan {
  if (parseSupportedHeader(log.headerLine) === null) return { kind: "skip", reason: "unknown-format" }

  const lines = log.lines
  const parsed: ParsedWrite[][] = []
  for (const line of lines) {
    const writes = parseTransaction(line)
    if (writes === null) return { kind: "skip", reason: "unknown-format" }
    parsed.push(writes)
  }

  // 每个物理 key 最后一次 delete / set 的行号：顺序遍历、后写覆盖先写，天然得到「最后一次」。
  const lastListDelete = new Map<string, number>()
  const lastValueDelete = new Map<string, number>()
  const lastValueSet = new Map<string, number>()
  for (let index = 0; index < parsed.length; index++) {
    for (const write of parsed[index]) {
      if (write.role === "delete") {
        const table = write.target === "list" ? lastListDelete : lastValueDelete
        table.set(write.physicalKey, index)
      } else if (write.role === "set") {
        lastValueSet.set(write.physicalKey, index)
      }
    }
  }

  const kept: string[] = []
  let droppedLines = 0
  let droppedWrites = 0
  for (let index = 0; index < lines.length; index++) {
    const writes = parsed[index]
    // 空数组行（`[]`，上游序列化产不出来的形状）不算「全部可丢」：留着它零成本，删它也没有收益。
    if (
      writes.length > 0 &&
      writes.every((write) => isDroppable(write, index, lastListDelete, lastValueDelete, lastValueSet))
    ) {
      droppedLines += 1
      droppedWrites += writes.length
      continue
    }
    kept.push(lines[index])
  }

  if (droppedLines === 0) return { kind: "skip", reason: "nothing-to-reclaim" }

  return {
    kind: "fold",
    // 保留行是原文字符串本身（S-2 构造性成立），形状与上游 serializeStorage 一致。
    text: serializeCompleteLines(log.headerLine, kept),
    linesBefore: lines.length + 1,
    linesAfter: kept.length + 1,
    droppedLines,
    droppedWrites,
    bytesBefore: utf8ByteLength(serializeCompleteLines(log.headerLine, lines)),
    bytesAfter: utf8ByteLength(serializeCompleteLines(log.headerLine, kept)),
  }
}

// ---------------------------------------------------------------------------
// S-1：状态重放与摘要（折叠安全要求 3）
// ---------------------------------------------------------------------------

/**
 * 重放出来的逻辑状态 —— S-1 的比较对象，**字段表即契约**。
 *
 * 刻意**不纳入**：
 *   · `stats`：`messageCount` 是 entries 的纯函数、usage 合计是 usage 的纯函数（且是浮点累加、
 *     对写入顺序敏感），纳入不增加鉴别力，只会多一个假失败面；
 *   · `entriesBySeq`：恒等于 entries 按 seq 升序，重复。
 */
export interface LogState {
  /** seq 高水位：每条写入 apply 后 `nextSeq = max(nextSeq, seq + 1)`，再与 header.nextSeq 取 max（storage.js:141-142）。 */
  nextSeq: number
  /** entry：id → 去掉 `kind` 之后的整个对象（含 seq / parentId / timestamp / type / customType / data / message），按 seq 升序。 */
  entries: Array<[string, unknown]>
  /** value：物理 key → { seq, value }（delete 后该 key 不存在）。 */
  scalarValues: Array<[string, { seq: number; value: unknown }]>
  /** list：物理 key → [{ seq, value }, …]（**元素**按出现顺序 —— 它是语义，上游 readList 不重排）。 */
  listValues: Array<[string, Array<{ seq: number; value: unknown }>]>
  /** usage：id → 去掉 `kind` 之后的整个对象。 */
  usage: Array<[string, unknown]>
}

/**
 * entry / usage 的 id 不在本模块的白名单校验范围内（折叠不动这两类行），但摘要需要**稳定**的
 * 字符串键：统一 `String(id)` 归一，两侧同一份代码。实践中 id 是 uuidv7 字符串，这一步恒等。
 */
function idKeyOf(id: unknown): string {
  return String(id)
}

/**
 * header.nextSeq 是快照重写留下的高水位：上游在 open 末尾取它与重放结果的较大者
 * （`storage.js:141-142` → `advanceNextSeq`，`in-memory-storage-state.js:109-114`）。
 *
 * 只在 header 认得（v4 + storageVersion 1）时吸收 —— 折叠只在这种文件上发生，且折叠前后 header
 * 逐字相同，吸收与否不影响两侧比较。非法值（上游 advanceNextSeq 会抛）**不吸收**：本函数对畸形
 * header 不抛，那样的文件在上游 open 阶段本来就打不开。
 */
function nextSeqWithHeader(nextSeq: number, headerLine: string): number {
  const headerNextSeq = parseSupportedHeader(headerLine)?.nextSeq
  return isSafeIntegerAtLeast(headerNextSeq, 1) ? Math.max(nextSeq, headerNextSeq) : nextSeq
}

/** 字符串键（物理 key 与 entry/usage id）的字典序，按 UTF-16 码元、与宿主 locale 无关。 */
function byStringKey(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * 把日志文本重放成逻辑状态 —— 逐条对齐上游 `InMemoryStorageState.applyValidated`
 * （`in-memory-storage-state.js:53-108`：4 个 case 的 switch + 每条写入之后推进 seq 高水位）：
 *   entry → `entries.set(id, 去掉 kind 的整对象)`；usage → `usage.set(id, …)`；
 *   value/delete → `scalarValues.delete(pk)`；value/set → `scalarValues.set(pk, { value, seq })`；
 *   list/delete → `listValues.delete(pk)`；list/append → 对应数组 push `{ seq, value }`。
 * 物理 key 与判定侧同源（`physicalKeyOf` 用的 `ADDRESS_SEPARATOR`）；scalarValues 与 listValues 是两张
 * 独立的表（同一个 key 串可以同时存在于两边，因此 delete 必须按 target 分表）。
 *
 * **只对 prepareFold 认得的日志成立**：某一行不是合法事务时抛错，而**不是**返回残缺状态 ——
 * 残缺状态会让两侧摘要「一致地错」，把失败伪装成通过（正是文件头写明的诚实边界要防的事）。
 * 正常路径不会触到它：摘要只在 `prepareFold` 返回 fold 之后才算，那时每一行都已过白名单。
 */
export function replayLogState(log: FoldLog): LogState {
  const entries = new Map<string, { seq: number; entry: unknown }>()
  const scalarValues = new Map<string, { seq: number; value: unknown }>()
  const listValues = new Map<string, Array<{ seq: number; value: unknown }>>()
  const usage = new Map<string, unknown>()
  let nextSeq = 1

  for (let index = 0; index < log.lines.length; index++) {
    const writes = parseTransaction(log.lines[index])
    if (writes === null) {
      throw new Error(`会话日志第 ${index + 2} 行不是合法事务（未知格式），无法重放逻辑状态`)
    }
    for (const write of writes) {
      switch (write.role) {
        case "keep": {
          // `keep` 只覆盖 entry / usage 两种 kind（其余 kind 在 parseWrite 的白名单里被挡下）。
          const { kind, ...rest } = write.raw
          if (kind === "entry") entries.set(idKeyOf(rest.id), { seq: write.seq, entry: rest })
          else usage.set(idKeyOf(rest.id), rest)
          break
        }
        case "set":
          scalarValues.set(write.physicalKey, { seq: write.seq, value: write.raw.value })
          break
        case "append": {
          const element = { seq: write.seq, value: write.raw.value }
          const stored = listValues.get(write.physicalKey)
          if (stored === undefined) listValues.set(write.physicalKey, [element])
          else stored.push(element)
          break
        }
        case "delete": {
          const table = write.target === "list" ? listValues : scalarValues
          table.delete(write.physicalKey)
          break
        }
      }
      // 上游逐写推进 `nextSeq = write.seq + 1`（最后一行写赢），在本模块里等价于 **max(seq) + 1**：
      // 上游 `validateCommittedWrites` 要求 seq 在文件里严格递增（不满足就 open 失败，`commit.js:33-40`），
      // 合法文件里「最后一行的 seq」就是 max(seq)，两种写法结果逐位相同。
      // 取 max 是刻意的：摘要必须只依赖**逻辑状态** —— 行序不是状态的一部分（同一份状态可以来自
      // 不同行序，摘要必须相同），而「最后一行」是行序的函数。
      nextSeq = Math.max(nextSeq, write.seq + 1)
    }
  }

  return {
    nextSeq: nextSeqWithHeader(nextSeq, log.headerLine),
    // 四张表都按**键**排序（entries 按 seq，其余按字符串键的字典序）：Map 的插入顺序是重放路径的副产品，不是逻辑状态的一部分 ——
    // 同一份状态可以来自不同的行序（探针的「交换两行」用例），摘要必须相同。
    // listValues 的**元素**顺序不排：它是语义（上游 readList 按出现顺序切片）。
    entries: [...entries]
      .sort((left, right) => left[1].seq - right[1].seq)
      .map(([id, held]): [string, unknown] => [id, held.entry]),
    scalarValues: [...scalarValues]
      .sort(([left], [right]) => byStringKey(left, right))
      .map(([key, held]): [string, { seq: number; value: unknown }] => [key, held]),
    listValues: [...listValues]
      .sort(([left], [right]) => byStringKey(left, right))
      .map(([key, elements]): [string, Array<{ seq: number; value: unknown }>] => [key, elements]),
    usage: [...usage].sort(([left], [right]) => byStringKey(left, right)),
  }
}

/**
 * 逻辑状态的稳定摘要：`sha256Text(stableSerialize(replayLogState(log)))`。
 *
 * 输入只依赖重放出的状态（LogState 的字段表）：行序、行数、字节数、行排版一律不参与 —— 它们是
 * 折叠必然改变的东西，掺进来会让校验恒失败。序列化用 `stableSerialize`（递归按 key 排序、
 * 非有限数归一为 `null`），因此不依赖字段写入顺序。
 *
 * **先算后写**：调用方必须先算两侧摘要再动盘，不一致就返回 skip("hash-mismatch") 并保留原文件。
 */
export async function logStateDigest(log: FoldLog): Promise<string> {
  return sha256Text(stableSerialize(replayLogState(log)))
}

// ---------------------------------------------------------------------------
// T5.02：折叠驱动 —— 唯一碰 FileSystem、唯一留痕的地方（源方案 §7.1「折叠安全要求 1：原子替换」）
// ---------------------------------------------------------------------------

const log = createLogger("SessionFold")

// 折叠结果经**会话写路径**落地（SessionFileSystem → 宿主 `session_write_text`），守卫按该路径
// 的上限 SESSION_WRITE_MAX_BYTES（session-file-system.ts，与 FOLD_POLICY.maxFileBytes 同值）判定，
// 不再按工具面 `file_write` 的 5 MiB（MAX_TOOL_FILE_BYTES）—— 那条上限只约束模型文件工具，
// 会话写路径是「只限会话根」的专用放宽（2026-10-06 折叠批次）。常量只在 session-file-system.ts
// 定义一份，这里 import，不给它第二个定义点。

/**
 * 上游 storageVersion 升级绊线（O-8 第一层，唯一「不靠人记得」的一环）：本模块的白名单解析
 * 只对 `1` 成立。`JSONL_STORAGE_VERSION` 在包里的声明是字面量类型（`jsonl/types.d.ts:4`），
 * 依赖升级改了常量值 ⇒ 这一行赋值类型不匹配、`pnpm run test:types`（vue-tsc）立即报错。
 *
 * **升级处置路径（先看报错、再核对、最后才改下面这行显式比较）**：上游 `storageVersion` 升级
 * ⇒ 先看 `pnpm run test:types` 的绊线报错，再按 `jsonl/storage.js:20-45`（parseCommittedWrite）
 * 重核白名单与「单写行 vs 数组行」的序列化规则（`storage.js:56-58`）。
 *
 * O-8 的三层机制（T5.02 步骤 5 的落地；全部无新增文档、无常驻物）：
 *   ① 编译期绊线＝本行：捕捉「依赖已升级」，升级只能手动（`package.json` 精确锁版本、仓库无
 *      renovate/dependabot），这一层是唯一自动的一环；
 *   ② 运行期绊线：`prepareFold` 对 `storageVersion ≠ 1`（或 `v ≠ 4`）的头、与任何非白名单行，
 *      一律 `skip("unknown-format")`，`reportUnknownFormat` 按版本值去重留痕（首次 warn、之后
 *      debug）—— 捕捉「本地没重新构建、用户盘上却已有新版本文件」，只降级、不抛错、不影响会话
 *      功能；
 *   ③ 人读的登记点：本文件头的「上游耦合（O-8 的登记点）」段（依赖的字段白名单出处 + 升级处置
 *      路径）；文档侧由 W6 落进 `docs/current/runtime-data.md`。
 */
const STORAGE_VERSION_GUARD: 1 = JSONL_STORAGE_VERSION

/**
 * 已留过痕的 `storageVersion` 值（字符串化的原值）：同一版本只 warn 一次，之后降为 debug。
 *
 * 跳过折叠本身不影响会话功能（折叠是优化不是正确性要求），所以常态跳过只记 debug；但「格式
 * 不认识」意味着 `storageVersion` 变了、本层的持续成本被触发，必须有一次醒目的信号。去重先例：
 * `src/services/session/repo.ts` 的 `reportedForeignRootIds`。
 */
const reportedStorageVersions = new Set<string>()

/**
 * 折叠结果（**执行契约**，T5.03/T5.04 的挂点按它判成败）。
 *
 * `skipped` 是**正常路径**：折叠是优化不是正确性要求，调用方拿 reason 记一笔就照常继续，
 * 不需要也不得因此中断会话。
 */
export type FoldOutcome =
  | {
      kind: "folded"
      path: string
      /** 参与折叠的完整行部分的 UTF-8 字节（撕裂文件不含被丢弃的半行；非撕裂文件 = 文件字节数）。 */
      bytesBefore: number
      /** 折叠后正文的 UTF-8 字节。 */
      bytesAfter: number
      /** 完整行数（含 header）。 */
      linesBefore: number
      linesAfter: number
      droppedLines: number
      /** 折叠前后的逻辑状态摘要（两侧相同才允许落盘）。 */
      digest: string
    }
  | {
      kind: "skipped"
      /**
       * `FoldSkipReason`（纯函数的判定结论：unknown-format / nothing-to-reclaim / too-large /
       * hash-mismatch）加上驱动侧的四类：`probe-too-small`（闸门 1）、`write-failed`、
       * `read-failed`。`hash-mismatch` 本已在 `FoldSkipReason` 里，此处按 T5.02 的执行契约逐字保留。
       */
      reason: FoldSkipReason | "probe-too-small" | "hash-mismatch" | "write-failed" | "read-failed"
    }

/**
 * 与目标**同目录**的唯一临时路径：`${path}.tmp-<base36 时间>-<8 位随机>`。
 *
 * 为什么不用上游的固定名 `${path}.tmp`（`jsonl/storage.js:71` 的 publishFileAtomically 用它）：
 * 固定名在同进程并发折叠时会互撞；Rust 自己的 `file_write_atomic` 用
 * `{name}.tmp-{pid}-{nanos}`（`tool_exec/mod.rs:777`），本函数取后者风格。
 *
 * 同目录不是风格问题：`renameFile` 不跨文件系统（`types.d.ts:189`「Does not copy across
 * filesystems」），用 `createTempFile` 会落到系统 temp 而被内核拒绝。
 */
function tempPathFor(path: string): string {
  const nonce = globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10)
  return `${path}.tmp-${Date.now().toString(36)}-${nonce}`
}

/**
 * 失败路径的临时文件清理：尽力而为。
 * 清理失败**不改返回值**（原文件不受影响），但绝不静默 —— 统一留痕点就是本函数。
 */
async function discardTempFile(fileSystem: FileSystem, tempPath: string, context: Context): Promise<void> {
  const removed = await fileSystem.remove(tempPath, { force: true }, context)
  if (!removed.ok) log.warn("折叠的临时文件清理不掉（原文件未受影响）:", tempPath, formatError(removed.error))
}

/**
 * `unknown-format` 的留痕：按 `storageVersion` 值去重，首次 warn、之后 debug。
 *
 * 认不出的两种形态共用一条留痕：header 不是 v4 + `storageVersion: 1`（上游升版本，或 v3-legacy
 * 头），以及某一行不是白名单事务（内容异常）。两种都意味着「本层在这个文件上不工作」，第一次
 * 必须醒目；去重键取 header 里的版本原值（解析不出 header 时是 `undefined` 的字符串化）。
 */
function reportUnknownFormat(path: string, headerLine: string): void {
  const version = parseHeaderObject(headerLine)?.storageVersion
  const versionKey = String(version)
  if (reportedStorageVersions.has(versionKey)) {
    log.debug("折叠跳过：日志格式不在本层白名单内（该版本已报过）:", path, version)
    return
  }
  reportedStorageVersions.add(versionKey)
  log.warn("折叠跳过：会话日志格式不在本层白名单内（上游可能已升 storageVersion）:", {
    path,
    storageVersion: version,
    supportedStorageVersion: JSONL_STORAGE_VERSION,
    supportedFormatVersion: SUPPORTED_FORMAT_VERSION,
  })
}

/**
 * 折叠一个会话日志文件：读一次 → 判定 → 摘要校验 → 写同目录临时文件 → `renameFile` 覆盖。
 *
 * **幂等**：无可回收内容时不做任何写入（第二次调用会落在闸门 1 或 skip("nothing-to-reclaim")）。
 * **前置条件**：该文件当前没有写入者 —— open 前，或 `releasePiSession` 里 `await session.close()`
 * 之后（挂点是 T5.03/T5.04 的活，本函数不认识它们）。
 * **全程经调用方传入的 `fileSystem`**（`session-repo.ts` 里是 W1 装饰过的那个实例），不绕开它
 * 直连底层 FS —— 折叠重写与帧缓冲里的帧靠装饰器的「同路径先 flush」排开，绕开就会互相盖掉
 * （W5 接口约定第 2 条）。`context` 只向 FileSystem 转发，本函数不读它的任何字段。
 * **失败一律不抛**：返回 `skipped` 并留痕，调用方照常继续。
 *
 * 顺序即契约（执行方案 T5.02 步骤 2）：闸门 1（一次 stat）→ 读取守卫（maxFileBytes，折叠自愿的
 * 上界）→ 读全文 → 白名单判定 → 闸门 2（可回收量）→ 结果守卫（SESSION_WRITE_MAX_BYTES，会话写
 * 路径的真实上限）→ 摘要校验 → **此处之前磁盘上什么都没发生** → 写临时文件 → rename 覆盖。
 * 临时文件与覆盖目标的写走调用方 FileSystem 的 `writeFile`（生产里 `SessionFileSystem` 把会话根
 * 内的写分流到放宽的 `session_write_text`）；本函数不自己认识会话根，路径策略在那一侧。
 */
export async function foldSessionFile(fileSystem: FileSystem, path: string, context: Context): Promise<FoldOutcome> {
  // 1. 闸门 1：一次 stat 就能判死小文件，不读正文（Read 一次全文比 stat 贵得多）
  const probe = await fileSystem.fileInfo(path, context)
  if (!probe.ok) {
    log.warn("折叠前探测会话文件失败，跳过折叠:", path, formatError(probe.error))
    return { kind: "skipped", reason: "read-failed" }
  }
  if (probe.value.size <= FOLD_POLICY.minFileBytes) {
    log.debug("折叠跳过：文件未过闸门 1（体积 ≤ minFileBytes）:", path, probe.value.size)
    return { kind: "skipped", reason: "probe-too-small" }
  }
  // 会话读路径没有单次大小上限：会话根内的读取经 `session-file-system.ts:33-35` 转到宿主
  // `session_read_text`（`crates/native-host/src/commands/session_fs.rs:10-38`；Rust 单测
  // `reads_large_sessions_and_only_requested_header` 证明 >5 MiB 可整读、按行读不解码尾部）。
  // MAX_TOOL_FILE_BYTES（5 MiB）只约束**工具面**写（`native-execution-env.ts:44,178` 的 file_write；
  // 会话根内的写另有 SESSION_WRITE_MAX_BYTES 专用上限，见步骤 5）——旧守卫把工具面写上限误用到
  // 读侧，文件一过 5 MiB 就永远折不动。这里改用 FOLD_POLICY.maxFileBytes：
  // 它只是折叠自愿设的读上界（见 FOLD_POLICY 的注释），不是任何读路径的物理限制。
  // 注入自定义非会话 FileSystem 的测试/场景里读仍可能受 5 MiB 限制（那些路径走 `file_read` 的
  // MAX_TOOL_FILE_BYTES）—— 那时 readTextFile 失败，下面的 read-failed 分支如实跳过（不是崩溃、
  // 不影响会话功能）。
  if (probe.value.size > FOLD_POLICY.maxFileBytes) {
    log.warn("折叠跳过：文件超过折叠读取守卫 FOLD_POLICY.maxFileBytes，不读不折:", path, probe.value.size, FOLD_POLICY.maxFileBytes)
    return { kind: "skipped", reason: "too-large" }
  }

  // 2. 读一次全文：闸门 1 与闸门 2 之间只读这一次
  const read = await fileSystem.readTextFile(path, context)
  if (!read.ok) {
    log.warn("折叠前读取会话文件失败，跳过折叠:", path, formatError(read.error))
    return { kind: "skipped", reason: "read-failed" }
  }

  // 3. 判定（纯函数）：header 的版本降级与行级白名单都在 prepareFold 里，结论只有 skip reason。
  //    在它之前不解析 header、之后不重复解析 —— 一次判定即一次结论（本条 = O-8 的运行期绊线）。
  const foldLog = readFoldLog(read.value)
  const plan = prepareFold(foldLog)
  if (plan.kind === "skip") {
    if (plan.reason === "unknown-format") reportUnknownFormat(path, foldLog.headerLine)
    else log.debug("折叠跳过：没有整行可回收:", path)
    return { kind: "skipped", reason: plan.reason }
  }

  // 4. 闸门 2：可回收字节的两个下界（AND）；口径一律 UTF-8 字节，与闸门 1、与 Rust 侧同口径。
  //    省下的字节不够一次 write + rename 的成本与风险，就不重写。
  const reclaimed = plan.bytesBefore - plan.bytesAfter
  if (reclaimed < FOLD_POLICY.minReclaimBytes || reclaimed < plan.bytesBefore * FOLD_POLICY.minReclaimRatio) {
    log.debug("折叠跳过：可回收量未过闸门 2:", {
      path,
      reclaimed,
      bytesBefore: plan.bytesBefore,
      minReclaimBytes: FOLD_POLICY.minReclaimBytes,
      minReclaimRatio: FOLD_POLICY.minReclaimRatio,
    })
    return { kind: "skipped", reason: "nothing-to-reclaim" }
  }

  // 5. 兜底：绝不折叠出一个会话写路径写不出去的文件 —— 结果经 `session_write_text` 落地
  //    （SessionFileSystem 分流），SESSION_WRITE_MAX_BYTES 是那条路径的真实约束；本仓阈值下
  //    「结果 ≤ 输入 ≤ FOLD_POLICY.maxFileBytes = 上限」，分支只为把守卫写全、不靠推理。
  //    注入的非会话 FileSystem 仍按各自上限失败 ⇒ 如实落到下面的 write-failed（不伪装成功）。
  if (plan.bytesAfter > SESSION_WRITE_MAX_BYTES) {
    log.warn("折叠跳过：折叠结果仍超过会话写上限:", path, plan.bytesAfter, SESSION_WRITE_MAX_BYTES)
    return { kind: "skipped", reason: "too-large" }
  }

  // 6. S-1：**先算后写**。两侧重放摘要一致才允许动盘；不一致时磁盘上什么都没发生、原文件保持
  //    原样 —— 这是正确性告警（折叠器在这份数据上不安全），每次都报，不按版本去重。
  const digestBefore = await logStateDigest(foldLog)
  const digestAfter = await logStateDigest(readFoldLog(plan.text))
  if (digestBefore !== digestAfter) {
    log.warn("折叠放弃：折叠前后重放状态摘要不一致（磁盘未改动，原文件保持原样）:", {
      path,
      digestBefore,
      digestAfter,
      droppedLines: plan.droppedLines,
      droppedWrites: plan.droppedWrites,
    })
    return { kind: "skipped", reason: "hash-mismatch" }
  }

  // 7. 原子替换：写同目录临时文件 → renameFile 覆盖。任何一步失败都清掉临时文件、保留原文件。
  const tempPath = tempPathFor(path)
  const written = await fileSystem.writeFile(tempPath, plan.text, context)
  if (!written.ok) {
    log.warn("折叠写入临时文件失败，原文件未改动:", tempPath, formatError(written.error))
    await discardTempFile(fileSystem, tempPath, context)
    return { kind: "skipped", reason: "write-failed" }
  }
  const renamed = await fileSystem.renameFile(tempPath, path, context)
  if (!renamed.ok) {
    // rename 是原子操作：失败时原文件必然逐字完好，没有「写了一部分」的中间态
    log.warn("折叠替换失败（rename），原文件逐字完好:", path, formatError(renamed.error))
    await discardTempFile(fileSystem, tempPath, context)
    return { kind: "skipped", reason: "write-failed" }
  }

  log.info("会话日志已折叠:", {
    path,
    bytes: `${plan.bytesBefore} → ${plan.bytesAfter}`,
    lines: `${plan.linesBefore} → ${plan.linesAfter}`,
    droppedLines: plan.droppedLines,
    droppedWrites: plan.droppedWrites,
    digest: digestAfter,
  })
  return {
    kind: "folded",
    path,
    bytesBefore: plan.bytesBefore,
    bytesAfter: plan.bytesAfter,
    linesBefore: plan.linesBefore,
    linesAfter: plan.linesAfter,
    droppedLines: plan.droppedLines,
    digest: digestAfter,
  }
}
