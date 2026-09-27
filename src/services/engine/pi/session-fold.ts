// ==========================================
// 会话 JSONL 日志的纯删除式折叠：log → log'（执行方案 W5 的 T5.00 核心；源方案 §7.1 方案一）
//
// 会话文件是 append-only：帧（`pi.pending.assistant_frame`）的每次流式增量追加一行，而
// `list/delete` / `value/delete` 只追加一条删除记录 —— 被删 key 的历史 append 不会从盘上
// 消失（W1 的帧节流只降写入频率，不动体积）。折叠把「确定可丢」的整行**纯删除**掉，是
// write + rename 之外唯一的物理回收手段。
//
// 判定规则（唯一两条；只删 append/set，delete 行本身永远保留）：
//   · `list`  key = namespace + U+0000 + key：设 d = 该 key **最后一次** `list/delete` 的行号，
//     行号 < d 的 `list/append` 可丢；行号 ≥ d 的写入（含 d 自己）一律保留。
//   · `value` key：同理，候选是 `value/set`，d = 最后一次 `value/delete` 的行号。
//   ⇒ replay(原日志) === replay(折叠后日志)：对不存在的 key 做 delete 与「append 一堆再 delete」
//     终态相同；只丢「最后一次 delete 之前」的写入，保证「先 delete 后又被 append/set」的 key
//     不被误判为死 key（执行方案 §1.9 实测该形态出现 0 次，但折叠器**不假定**它，必须运行时检查）。
//
// 三条硬性质（源方案 §8.5）：
//   S-2 只删不增、保留行逐字不变 —— 构造性成立：输出 = header 原文 + 保留行原文的换行连接，
//       本文件从不重新序列化任何保留行（全文没有一处 JSON 重序列化调用）。
//   S-3 不改变任何 entryId 与 seq —— entry/usage 行一个不动，也不新增写入，不需要重编号，
//       header 里的 nextSeq 高水位原样保留。
//   X-1 entry 集合不变 ⇒ 折叠前后展示地址（shortenAddresses 的取值）逐字相同。
//
// 单位口径（本波唯一的单位陷阱）：字节一律是 **UTF-8 字节**（TextEncoder），与 Rust 侧
// `file_write` 判上限用的 `content.len()` 同口径；禁用 `String.length`（UTF-16 长度，中文
// 内容下差约 3 倍，且 ASCII 夹具查不出来）。
//
// 上游耦合（O-8 的登记点）：白名单逐条对齐 `harness/session/jsonl/storage.js:20-45`
// （parseCommittedWrite）与 `commit.js:7-22`（commitWrite）；`v: 4` 来自 `jsonl/types.d.ts:3`。
// 上游升版本 ⇒ 先看 `pnpm run test:types` 的绊线报错（T5.02 落在本文件的 STORAGE_VERSION_GUARD），
// 再重核白名单与「单写行 vs 数组行」的序列化规则（`storage.js:56-58`）。
//
// 本文件是**纯函数**模块：不碰 FileSystem、无副作用、不落任何日志 —— 所有「不折叠」的结论都以
// FoldSkipReason 返回给调用方，没有一条失败被吞掉。留痕的唯一出口是 T5.02 的 foldSessionFile
// （createLogger("SessionFold")），等级按执行方案 T5.02 步骤 4 的表。
// ==========================================

import { JSONL_STORAGE_VERSION } from "@earendil-works/pi-agent-core/harness/session"

/**
 * 折叠策略（O-6 的裁定口径；本模块是这三个阈值的**唯一**定义点，不建大一统 constants 文件）。
 * 纯函数只负责算「可回收多少」，闸门由 T5.02 的 foldSessionFile 按文件大小与回收量施加。
 */
export const FOLD_POLICY = {
  /** 闸门 1：文件字节 ≤ 此值不探测（避免为小文件白读一次全文）。 */
  minFileBytes: 512 * 1024,
  /** 闸门 2：可回收字节低于此值不重写（重写自身有一次 write+rename 的成本与风险）。 */
  minReclaimBytes: 128 * 1024,
  /** 闸门 2b：可回收比例低于此值不重写。 */
  minReclaimRatio: 0.15,
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
  /** 原文或折叠结果超过 MAX_TOOL_FILE_BYTES（由 T5.02 的驱动按文件上限产生，纯函数不看文件大小）。 */
  | "too-large"

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

/** 白名单解析的结果：判定只关心「这条写是不是候选」与它归属哪个物理 key。 */
type ParsedWrite =
  | { role: "append"; physicalKey: string }
  | { role: "set"; physicalKey: string }
  | { role: "delete"; target: "list" | "value"; physicalKey: string }
  | { role: "keep" }

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
      return isSafeIntegerAtLeast(write.timestamp, 0) ? { role: "keep" } : null
    case "usage":
      return { role: "keep" }
    case "value":
    case "list": {
      const physicalKey = physicalKeyOf(write)
      if (physicalKey === null) return null
      if (write.op === "delete") return { role: "delete", target: write.kind, physicalKey }
      // append 只属于 list、set 只属于 value；错配组合不在白名单里（storage.js:30-41）。
      if (write.op === "append" && write.kind === "list") return { role: "append", physicalKey }
      if (write.op === "set" && write.kind === "value") return { role: "set", physicalKey }
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
 * header 必须是本模块认得的 v4 + `storageVersion: 1` 头。
 *
 * 空串 = 文件一个换行都没有（上游 splitCompleteLines 返回 `lines: []`，open 按「missing
 * header」拒绝，`storage.js:117-119`）；v3-legacy 头（`type: "session"` / `version: 3`）也在这里
 * 被挡下 —— 折叠只对 v1 的字段白名单成立，认不出就跳过（安全降级，不影响会话功能）。
 */
function isSupportedHeader(headerLine: string): boolean {
  if (headerLine === "") return false
  let value: unknown
  try {
    value = JSON.parse(headerLine)
  } catch {
    // 同上：不是被吞掉的失败，是 skip("unknown-format") 的判据（留痕在 foldSessionFile）。
    return false
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const header = value as Record<string, unknown>
  return (
    header.kind === "header" &&
    header.v === SUPPORTED_FORMAT_VERSION &&
    header.storageVersion === JSONL_STORAGE_VERSION
  )
}

/**
 * 一条写是否「确定可丢」：只有 list/append 与 value/set 是候选，且行号必须**严格小于**该 key
 * 最后一次 delete 的行号。行号 ≥ d 的写入（含最后那次 delete 自己）一律保留。
 *
 * 这条「只看最后一次 delete 之前」的写死规则就是「先 delete 后又 append」不被误删的全部依据。
 */
function isDroppable(
  write: ParsedWrite,
  lineIndex: number,
  lastListDelete: ReadonlyMap<string, number>,
  lastValueDelete: ReadonlyMap<string, number>,
): boolean {
  if (write.role === "append") {
    const lastDelete = lastListDelete.get(write.physicalKey)
    return lastDelete !== undefined && lineIndex < lastDelete
  }
  if (write.role === "set") {
    const lastDelete = lastValueDelete.get(write.physicalKey)
    return lastDelete !== undefined && lineIndex < lastDelete
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
 * 判定（唯一规则，两条）：
 *   · 对 list  key = namespace + U+0000 + key：设 d = 该 key **最后一次** `list/delete` 的行号；
 *     行号 < d 的 `list/append` 可丢；行号 > d 的 append 必须保留。
 *   · 对 value key：设 d = 该 key **最后一次** `value/delete` 的行号；
 *     行号 < d 的 `value/set` 可丢；行号 > d 的 set 必须保留。
 *
 * 行级粒度：**仅当一行里的全部写入都可丢时才删除该行**；一行里只要有一个保留写入，整行原样
 * 保留（不做重序列化、不重排）。header 行永远保留。任一行 JSON.parse 失败、或 kind/op 不在
 * 白名单、或缺少判定必需字段 ⇒ 返回 skip("unknown-format")，原文件不动。
 *
 * 一行都不可丢时返回 skip("nothing-to-reclaim")：调用方据此跳过重写（按阈值判断「这点回收量
 * 值不值得重写」是 T5.02 的闸门 2/2b，纯函数不掺和）。
 */
export function prepareFold(log: FoldLog): FoldPlan {
  if (!isSupportedHeader(log.headerLine)) return { kind: "skip", reason: "unknown-format" }

  const lines = log.lines
  const parsed: ParsedWrite[][] = []
  for (const line of lines) {
    const writes = parseTransaction(line)
    if (writes === null) return { kind: "skip", reason: "unknown-format" }
    parsed.push(writes)
  }

  // 每个物理 key 最后一次 delete 的行号：顺序遍历、后写覆盖先写，天然得到「最后一次」。
  const lastListDelete = new Map<string, number>()
  const lastValueDelete = new Map<string, number>()
  for (let index = 0; index < parsed.length; index++) {
    for (const write of parsed[index]) {
      if (write.role !== "delete") continue
      const table = write.target === "list" ? lastListDelete : lastValueDelete
      table.set(write.physicalKey, index)
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
      writes.every((write) => isDroppable(write, index, lastListDelete, lastValueDelete))
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
