#!/usr/bin/env node
// 会话帧写入基线复算（离线、只读、零依赖；不启动应用、不碰 IPC）。
//
// 四条必须随文件一起维护的约定：
// 1) 口径来源：源方案 §11.2《测量方法（可复现，供 W1 复用）》
//    docs/history/implementation/会话压缩与存储瘦身方案-2026-09-27基线.md
//    · 必须先把事务数组行展开成多条写（漏展开会丢 delete，曾据此误判「零删除」）；
//    · 帧的 key 是 `${operationId}:${responseEntryId}`，帧内没有 delta 级时间戳，
//      时长只能用锚点法：结束锚点 = id 等于 responseEntryId 的 entry 的 timestamp，
//      起始锚点 = 该帧组最小 seq 之前最近一条 entry 的 timestamp；不得改用别的锚点。
// 2) 样本：被 .gitignore 的运行时数据根（默认 data/desk-pet/sessions）里的会话 JSONL，
//    属用户数据 —— 本脚本只读，绝不改写、绝不删除；--selftest 的合成样本只写系统 temp。
// 3) --calibrate 的模拟规则必须与装饰器实现保持一致：每文件一个缓冲 / 体积触发 /
//    非帧触发清空 / 同键 delta 合并（见 src/services/engine/harness/session-frame-buffer.ts，
//    T1.01/T1.02 + 同键 delta 合并）。
//    改装饰器的触发或合并规则就要同步改这里的模拟，否则校准表立刻失真。
// 4) --fold-preview 的行级判定与 src/services/engine/harness/session-fold.ts 的 prepareFold **同源**：
//    只删「该行全部写都是死 key（行号小于该物理 key 最后一次 delete 的行号）的 append/set」的整行；
//    delete 行、entry/usage 行与任何含保留写的多写行永远保留；保留行是原文子串（不重新序列化）。
//    改折叠规则要同步这里；两者不一致时以 session-fold.ts 为准。
//    字节一律 UTF-8（Buffer.byteLength），禁用 String.length（UTF-16 长度，中文差约 3 倍）。
//    该模式只用于选阈值（O-6 的三常量），不作门禁证据。
//
// 本目录是独立 Node CLI，直接用 console（与 scripts/e2e-test.mjs 同理：
// 应用侧的 logger 只在应用运行期可用，这里没有 IPC，也写不进 data_root 的日志）。

import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** 帧的命名空间；判别一律用结构比较，不用子串（同文件里 list/delete 也含这个字符串）。 */
const FRAME_NAMESPACE = "pi.pending.assistant_frame"
/** 默认样本根：相对脚本位置推导，不写死绝对路径。 */
const DEFAULT_ROOT = fileURLToPath(new URL("../data/desk-pet/sessions", import.meta.url))
/** --calibrate 的扫描阈值；这里只是扫描参数，生产定义点在 session-frame-buffer.ts（O-5 裁定 16 KiB）。 */
const CALIBRATION_THRESHOLDS_KIB = [8, 16, 32, 64]
const USAGE =
  "用法: node scripts/session-frame-stats.mjs [路径…] [--root <会话根>] [--calibrate] [--fold-preview] [--json] [--selftest]"

// ── 事务与帧的纯函数（--selftest 直接跑这一批，不依赖用户数据）──

function splitLines(text) {
  const lines = text.split("\n")
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  return lines
}

/**
 * 展开事务：第 1 行是 header 必须跳过；其余每行 JSON.parse 后
 * `Array.isArray(v) ? v : [v]` —— 数组行是多写事务，必须逐条展开（§11.2 第 1 条）。
 * 空行跳过；解析失败的行不计入写，只计数并在报告里如实标出。
 */
function expandTransactions(lines) {
  const writes = []
  let unparsedLines = 0
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index]
    if (line.trim() === "") continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      unparsedLines += 1
      continue
    }
    writes.push(...(Array.isArray(parsed) ? parsed : [parsed]))
  }
  return { writes, unparsedLines }
}

/** 结构判别：恰好是帧的 append 写。子串判别会把同命名空间的 list/delete 也算进来（实测 2065 vs 2056）。 */
function isFrameAppendWrite(write) {
  return (
    write !== null &&
    typeof write === "object" &&
    write.kind === "list" &&
    write.op === "append" &&
    write.namespace === FRAME_NAMESPACE
  )
}

function frameAppends(writes) {
  return writes.filter(isFrameAppendWrite)
}

/**
 * 帧行的字节口径 = 该行字节数 + 行尾换行，即装饰器实际收到的 content 长度
 * （行内容以单个 "\n" 结尾追加）。校准表与帧字节占比都用这个口径。
 */
function frameAppendLineBytes(lines) {
  let bytes = 0
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index]
    if (line.trim() === "") continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (!Array.isArray(parsed) && isFrameAppendWrite(parsed)) bytes += Buffer.byteLength(line, "utf8") + 1
  }
  return bytes
}

/** 小于 seq 的最大 entry（entries 已按 seq 升序）。 */
function lastEntryBefore(entries, seq) {
  let low = 0
  let high = entries.length - 1
  let found = null
  while (low <= high) {
    const middle = (low + high) >> 1
    if (entries[middle].seq < seq) {
      found = entries[middle]
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return found
}

/**
 * 逐帧响应时长与速率（§11.2 第 2、3 条）。writes 是可选复用参数：
 * 调用方已经展开过事务时传进来，避免同一文件被二次解析；
 * 只按文档签名 responseDurations(lines) 调用也成立。
 */
function responseDurations(lines, writes = expandTransactions(lines).writes) {
  const entries = writes
    .filter(write => write?.kind === "entry" && typeof write.seq === "number" && typeof write.timestamp === "number")
    .sort((a, b) => a.seq - b.seq)
  const entryById = new Map(entries.map(entry => [entry.id, entry]))
  const groups = new Map()
  for (const write of frameAppends(writes)) {
    if (typeof write.key !== "string") continue
    let group = groups.get(write.key)
    if (!group) {
      const separator = write.key.indexOf(":")
      group = {
        key: write.key,
        operationId: separator === -1 ? write.key : write.key.slice(0, separator),
        responseEntryId: separator === -1 ? "" : write.key.slice(separator + 1),
        appends: 0,
        minSeq: write.seq,
      }
      groups.set(write.key, group)
    }
    group.appends += 1
    group.minSeq = Math.min(group.minSeq, write.seq)
  }
  const result = []
  for (const group of groups.values()) {
    const end = entryById.get(group.responseEntryId)
    const anchor = lastEntryBefore(entries, group.minSeq)
    const durationMs = end && anchor ? end.timestamp - anchor.timestamp : null
    result.push({
      ...group,
      anchorEntryId: anchor?.id ?? null,
      anchorTimestamp: anchor?.timestamp ?? null,
      endTimestamp: end?.timestamp ?? null,
      durationMs,
      perSecond: typeof durationMs === "number" && durationMs > 0 ? group.appends / (durationMs / 1000) : null,
    })
  }
  result.sort((a, b) =>
    b.appends - a.appends || (a.responseEntryId < b.responseEntryId ? -1 : a.responseEntryId > b.responseEntryId ? 1 : 0),
  )
  return result
}

/**
 * 体积阈值扫描：模拟「每文件一个缓冲 / 体积触发 / 非帧触发清空 / 同键 delta 合并」（无定时器）。
 * 规则必须与 src/services/engine/harness/session-frame-buffer.ts 的实现一致：
 *   · 可合并 = 帧 append 的 value.type 以 `_delta` 结尾、value.delta 是字符串、seq 是安全整数；
 *     合并键 = (namespace, key, value.type, value.contentIndex)（contentIndex 缺失归一为 null）；
 *   · delta 入队时按 value.delta 的 UTF-8 字节累计估算；物化时按实际序列化行字节校准；
 *   · 物化边界 = 非 delta 帧（先物化再放行）与 drain（体积触发 / 非帧行 / 收尾 flush）；
 *   · 物化按最后 seq 升序（整文件 seq 严格递增）。
 * 缓冲字节 = chunks 各行的实际字节（含行尾换行）+ 合并项的 delta 估算字节；
 * 非帧行只在缓冲非空时产生一次 flush。
 */
function simulateBuffer(lines, thresholdBytes) {
  let bufferedBytes = 0
  let bufferedFrames = 0
  let volumeFlushes = 0
  let nonFrameFlushes = 0
  let mergedFrames = 0
  let writtenRows = 0
  /** 合并槽位：键 → { lastWrite, lastSeq, delta, estimatedBytes }（与装饰器同形）。 */
  const merged = new Map()
  /** 与装饰器的 materializeMergedDeltas 同序：按最后 seq 升序物化，字节按实际行校准。 */
  const materialize = () => {
    if (merged.size === 0) return
    for (const entry of [...merged.values()].sort((left, right) => left.lastSeq - right.lastSeq)) {
      const line = `${JSON.stringify({ ...entry.lastWrite, seq: entry.lastSeq, value: { ...entry.lastWrite.value, delta: entry.delta } })}\n`
      bufferedBytes += Buffer.byteLength(line, "utf8") - entry.estimatedBytes
      writtenRows += 1
    }
    merged.clear()
  }
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index]
    if (line.trim() === "") continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (!Array.isArray(parsed) && isFrameAppendWrite(parsed)) {
      const parts = deltaFrameParts(parsed)
      bufferedFrames += 1
      if (parts === null) {
        // 非 delta 帧：先物化再入队（合并绝不跨越 *_end 的覆盖语义边界）。
        materialize()
        bufferedBytes += Buffer.byteLength(line, "utf8") + 1
        writtenRows += 1
      } else {
        const addedBytes = Buffer.byteLength(parts.delta, "utf8")
        const slotKey = JSON.stringify([parts.namespace, parts.key, parts.type, parts.contentIndex ?? null])
        const entry = merged.get(slotKey)
        if (entry === undefined) {
          merged.set(slotKey, { lastWrite: parsed, lastSeq: parts.seq, delta: parts.delta, estimatedBytes: addedBytes })
        } else {
          entry.lastWrite = parsed
          entry.lastSeq = parts.seq
          entry.delta += parts.delta
          entry.estimatedBytes += addedBytes
        }
        bufferedBytes += addedBytes
      }
      if (bufferedBytes >= thresholdBytes) {
        volumeFlushes += 1
        mergedFrames += bufferedFrames
        materialize()
        bufferedBytes = 0
        bufferedFrames = 0
      }
      continue
    }
    if (bufferedFrames > 0) {
      nonFrameFlushes += 1
      mergedFrames += bufferedFrames
      materialize()
      bufferedBytes = 0
      bufferedFrames = 0
    }
  }
  // 文件结束时仍留在缓冲里的帧必须在关闭路径 flush（T1.04），否则会丢帧。
  const trailingFlushes = bufferedFrames > 0 ? 1 : 0
  if (trailingFlushes === 1) {
    mergedFrames += bufferedFrames
    materialize()
  }
  const flushes = volumeFlushes + nonFrameFlushes + trailingFlushes
  return {
    thresholdBytes,
    volumeFlushes,
    nonFrameFlushes,
    trailingFlushes,
    flushes,
    mergedFrames,
    writtenRows,
    mergedPerFlush: flushes > 0 ? mergedFrames / flushes : null,
    rowsPerFlush: flushes > 0 ? writtenRows / flushes : null,
  }
}

/**
 * 与装饰器 deltaFrameParts **同判定**的可合并 delta 帧字段；不合形状返回 null。
 * 判定更严不含糊：type 必须以 `_delta` 结尾、delta 必须是字符串、seq 必须是安全整数。
 */
function deltaFrameParts(write) {
  const seq = write.seq
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) return null
  if (typeof write.namespace !== "string" || typeof write.key !== "string") return null
  const value = write.value
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const { type, delta, contentIndex } = value
  if (typeof type !== "string" || !type.endsWith("_delta")) return null
  if (typeof delta !== "string") return null
  if (contentIndex !== undefined && (typeof contentIndex !== "number" || !Number.isSafeInteger(contentIndex) || contentIndex < 0)) return null
  return { seq, namespace: write.namespace, key: write.key, type, contentIndex, delta }
}

// ── 单个样本的汇总 ──

function summarize(text, bytes, samplePath) {
  const lines = splitLines(text)
  const { writes, unparsedLines } = expandTransactions(lines)
  const histogram = new Map()
  const deletedFrameKeys = new Set()
  for (const write of writes) {
    const label =
      write && typeof write.kind === "string" ? (typeof write.op === "string" ? `${write.kind}/${write.op}` : write.kind) : "unknown"
    histogram.set(label, (histogram.get(label) ?? 0) + 1)
    if (write?.kind === "list" && write.op === "delete" && write.namespace === FRAME_NAMESPACE && typeof write.key === "string") {
      deletedFrameKeys.add(write.key)
    }
  }
  const frames = frameAppends(writes)
  const groups = responseDurations(lines, writes)
  const timedGroups = groups.filter(group => typeof group.durationMs === "number")
  const timedAppends = timedGroups.reduce((total, group) => total + group.appends, 0)
  const durationMs = timedGroups.reduce((total, group) => total + group.durationMs, 0)
  const peakGroup = groups.reduce(
    (best, group) => (group.perSecond !== null && (best === null || group.perSecond > best.perSecond) ? group : best),
    null,
  )
  return {
    path: samplePath,
    bytes,
    lines: lines.length,
    writes: writes.length,
    unparsedLines,
    histogram,
    frames: groups,
    framesWithoutDuration: groups.length - timedGroups.length,
    frameAppends: frames.length,
    frameBytes: frameAppendLineBytes(lines),
    reclaimableAppends: frames.filter(write => typeof write.key === "string" && deletedFrameKeys.has(write.key)).length,
    deletedFrameKeys: deletedFrameKeys.size,
    durationMs,
    timedAppends,
    avgPerSecond: durationMs > 0 ? timedAppends / (durationMs / 1000) : null,
    peakGroup,
  }
}

function mergeSamples(summaries) {
  const histogram = new Map()
  const frames = []
  let bytes = 0
  let lines = 0
  let writes = 0
  let unparsedLines = 0
  let frameAppends = 0
  let frameBytes = 0
  let reclaimableAppends = 0
  let deletedFrameKeys = 0
  let durationMs = 0
  let timedAppends = 0
  let framesWithoutDuration = 0
  let peakGroup = null
  for (const sample of summaries) {
    bytes += sample.bytes
    lines += sample.lines
    writes += sample.writes
    unparsedLines += sample.unparsedLines
    frameAppends += sample.frameAppends
    frameBytes += sample.frameBytes
    reclaimableAppends += sample.reclaimableAppends
    deletedFrameKeys += sample.deletedFrameKeys
    durationMs += sample.durationMs
    timedAppends += sample.timedAppends
    framesWithoutDuration += sample.framesWithoutDuration
    for (const [label, count] of sample.histogram) histogram.set(label, (histogram.get(label) ?? 0) + count)
    for (const group of sample.frames) frames.push({ ...group, sample: sample.path })
    if (sample.peakGroup !== null && (peakGroup === null || sample.peakGroup.perSecond > peakGroup.perSecond)) {
      peakGroup = sample.peakGroup
    }
  }
  return {
    bytes,
    lines,
    writes,
    unparsedLines,
    frameAppends,
    frameBytes,
    frameByteRatio: bytes > 0 ? frameBytes / bytes : null,
    reclaimableAppends,
    reclaimableLineRatio: lines > 0 ? reclaimableAppends / lines : null,
    deletedFrameKeys,
    frameGroups: frames.length,
    framesWithoutDuration,
    durationMs,
    durationSeconds: durationMs / 1000,
    avgPerSecond: durationMs > 0 ? timedAppends / (durationMs / 1000) : null,
    peakPerSecond: peakGroup?.perSecond ?? null,
    peakResponseEntryId: peakGroup?.responseEntryId ?? null,
    peakAppends: peakGroup?.appends ?? null,
    histogram,
    frames,
  }
}

function sortedHistogram(histogram) {
  return [...histogram.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
}

/** report.totals.histogram 是普通对象（JSON 友好），排序规则与 sortedHistogram 一致。 */
function sortedHistogramEntries(histogram) {
  return Object.entries(histogram).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
}

/** 中日韩字符占两个显示列：padEnd 只数码点，中文表头会让列错位，这里按显示宽度补齐。 */
const WIDE_CHAR = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/

function displayWidth(text) {
  let width = 0
  for (const char of text) width += WIDE_CHAR.test(char) ? 2 : 1
  return width
}

const padDisplay = (text, width) => text + " ".repeat(Math.max(0, width - displayWidth(text)))

// ── 输出 ──

const fixed = (value, digits) => (typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "n/a")

function renderReport(report) {
  const { totals, frames } = report
  const out = []
  out.push(`[frame-stats] 样本 ${report.samples.length} 个:`)
  for (const sample of report.samples) {
    out.push(`  ${sample.path}`)
    out.push(`    字节 ${sample.bytes} · 行数 ${sample.lines} · 展开后写 ${sample.writes} · 无法解析行 ${sample.unparsedLines}`)
  }
  out.push("")
  out.push("写入直方图（kind/op）:")
  for (const [label, count] of sortedHistogramEntries(totals.histogram)) out.push(`  ${label.padEnd(20)}${count}`)
  out.push("")
  out.push(`帧（${totals.frameGroups} 组，append 数降序；时长=§11.2 锚点法）:`)
  out.push(`  ${"responseEntryId".padEnd(36)}${"append".padStart(8)}${"时长 ms".padStart(10)}${"次/秒".padStart(9)}`)
  for (const frame of frames) {
    out.push(
      `  ${frame.responseEntryId.padEnd(36)}${String(frame.appends).padStart(8)}${String(frame.durationMs ?? "n/a").padStart(10)}${fixed(frame.perSecond, 1).padStart(9)}`,
    )
  }
  if (totals.framesWithoutDuration > 0) {
    out.push(`  注意：${totals.framesWithoutDuration} 组算不出时长（缺 entry 锚点），已从合计时长中排除`)
  }
  out.push("")
  out.push(
    `合计: 帧 append ${totals.frameAppends} · 总时长 ${fixed(totals.durationSeconds, 3)} s · 平均 ${fixed(totals.avgPerSecond, 1)} 次/秒 · 峰值 ${fixed(totals.peakPerSecond, 1)} 次/秒（${totals.peakResponseEntryId}，${totals.peakAppends} 次 append）`,
  )
  out.push(`帧字节占比: ${totals.frameBytes} / ${totals.bytes} = ${fixed((totals.frameByteRatio ?? 0) * 100, 1)}%`)
  out.push(
    `可回收行占比: ${totals.reclaimableAppends} / ${totals.lines} = ${fixed((totals.reclaimableLineRatio ?? 0) * 100, 1)}%（已 delete 的 ${totals.deletedFrameKeys} 个帧 key 的全部 append；W5 折叠收益的度量入口）`,
  )
  return out.join("\n")
}

function renderCalibration(calibration, baselinePerSecond) {
  const out = []
  out.push("")
  out.push("O-5 阈值校准（模拟：每文件一个缓冲 / 体积触发 / 非帧触发清空 / 同键 delta 合并；规则须与 session-frame-buffer.ts 一致）")
  out.push(`基线（样本实测平均）: ${fixed(baselinePerSecond, 1)} 次/秒`)
  out.push("")
  out.push(
    `  ${padDisplay("阈值", 10)}${padDisplay("flush 次数", 12)}${padDisplay("体积 / 非帧", 14)}${padDisplay("合并帧/次", 12)}${padDisplay("落盘行/次", 12)}${padDisplay("落盘调用速率", 16)}相对基线`,
  )
  for (const row of calibration) {
    const threshold = padDisplay(`${row.thresholdKib} KiB`, 10)
    const flushes = padDisplay(String(row.flushes), 12)
    const split = padDisplay(`${row.volumeFlushes} / ${row.nonFrameFlushes}${row.trailingFlushes > 0 ? " + 1 收尾" : ""}`, 14)
    const perFlush = padDisplay(fixed(row.mergedPerFlush, 1), 12)
    const rowsPerFlush = padDisplay(fixed(row.rowsPerFlush, 1), 12)
    const rate = padDisplay(`${fixed(row.flushPerSecond, 2)} /s`, 16)
    const ratio = row.ratioToBaseline === null ? "n/a" : `${Math.round(row.ratioToBaseline)}×`
    out.push(`  ${threshold}${flushes}${split}${perFlush}${rowsPerFlush}${rate}${ratio}`)
  }
  out.push("")
  out.push("裁定（O-5）: 16 KiB —— 生产常量见 src/services/engine/harness/session-frame-buffer.ts（T1.01）；本脚本只是扫描器，不是定义点。")
  return out.join("\n")
}

// ── 折叠收益预览（--fold-preview；判定同源 src/services/engine/harness/session-fold.ts）──
//
// 判定规则与 session-fold.ts 的 prepareFold 同源；改折叠规则要同步这里；两者不一致时以
// session-fold.ts 为准。本模式只用于选阈值（O-6），不作门禁证据。
//
// 行级规则（与 prepareFold 逐条一致，函数名与那边一一对应是刻意的）：
//   · 只删「该行全部写都可丢」的整行；delete 行、entry/usage 行、含保留写的多写行一律保留；
//     保留行是原文子串，从不重新序列化（S-2）。
//   · 可丢 = 该写的物理 key（`${namespace}<U+0000>${key}`）在**最后一次** delete 之后没有再现，
//     且本行行号**严格小于**那次 delete 的行号；list 与 value 是两张独立的表，不合并。
// 字节口径：全部 UTF-8（Buffer.byteLength，与 session-fold.ts 的 TextEncoder 同口径）；
// 禁用 String.length（UTF-16 长度，中文内容下差约 3 倍）。

/** O-6 三常量；**唯一可调点是 session-fold.ts 的 FOLD_POLICY**，这里只是同值镜像，不反向平移。 */
const FOLD_POLICY = {
  minFileBytes: 512 * 1024,
  minReclaimBytes: 128 * 1024,
  minReclaimRatio: 0.15,
}
/** 物理 key 分隔符 U+0000（上游 in-memory-storage-state 的拼法）；写死避免源码里藏不可见控制字符。 */
const FOLD_ADDRESS_SEPARATOR = String.fromCharCode(0)
/** 与 session-fold.ts 的 SUPPORTED_FORMAT_VERSION / JSONL_STORAGE_VERSION(1) 对齐；上游升版本先改那边。 */
const FOLD_SUPPORTED_FORMAT_VERSION = 4
const FOLD_SUPPORTED_STORAGE_VERSION = 1

/** 镜像 session-fold.ts 的 readFoldLog：结尾有换行 = 无撕裂；没有换行 = 尾行不完整（丢弃并置 torn）。 */
function readFoldLog(text) {
  if (text.endsWith("\n")) {
    const lines = text.slice(0, -1).split("\n")
    return { headerLine: lines[0] ?? "", lines: lines.slice(1), torn: false }
  }
  const lastNewline = text.lastIndexOf("\n")
  if (lastNewline === -1) return { headerLine: "", lines: [], torn: true }
  const lines = text.slice(0, lastNewline).split("\n")
  return { headerLine: lines[0] ?? "", lines: lines.slice(1), torn: true }
}

/** 镜像 session-fold.ts 的 serializeCompleteLines：规范形状 `header\n…\n`，bytesBefore/After 都由它度量。 */
function serializeCompleteLines(headerLine, lines) {
  return lines.length === 0 ? `${headerLine}\n` : `${headerLine}\n${lines.join("\n")}\n`
}

const utf8ByteLength = text => Buffer.byteLength(text, "utf8")

function foldIsSafeIntegerAtLeast(value, minimum) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
}

/** 镜像 session-fold.ts 的 isSupportedHeader：只认 v4 + storageVersion 1 的头，认不出就跳过。 */
function foldIsSupportedHeader(headerLine) {
  if (headerLine === "") return false
  let value
  try {
    value = JSON.parse(headerLine)
  } catch {
    return false
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  return (
    value.kind === "header" && value.v === FOLD_SUPPORTED_FORMAT_VERSION && value.storageVersion === FOLD_SUPPORTED_STORAGE_VERSION
  )
}

/** 镜像 session-fold.ts 的 parseWrite：白名单不宽容未知 kind/op，对不上 = 整个文件 skip("unknown-format")。 */
function foldParseWrite(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  if (!foldIsSafeIntegerAtLeast(value.seq, 1)) return null
  if (value.kind === "entry") return foldIsSafeIntegerAtLeast(value.timestamp, 0) ? { role: "keep" } : null
  if (value.kind === "usage") return { role: "keep" }
  if (value.kind === "value" || value.kind === "list") {
    if (typeof value.namespace !== "string" || typeof value.key !== "string") return null
    const physicalKey = `${value.namespace}${FOLD_ADDRESS_SEPARATOR}${value.key}`
    if (value.op === "delete") return { role: "delete", target: value.kind, physicalKey }
    if (value.op === "append" && value.kind === "list") return { role: "append", physicalKey }
    if (value.op === "set" && value.kind === "value") return { role: "set", physicalKey }
    return null
  }
  return null
}

/** 镜像 session-fold.ts 的 parseTransaction：顶层数组 = 批量事务，逐条展开；任一条不合法整行不合法。 */
function foldParseTransaction(line) {
  let value
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  const rawWrites = Array.isArray(value) ? value : [value]
  const writes = []
  for (const raw of rawWrites) {
    const write = foldParseWrite(raw)
    if (write === null) return null
    writes.push(write)
  }
  return writes
}

/** 镜像 session-fold.ts 的 isDroppable：只有 append/set 是候选，且行号严格小于该表最后一次 delete 的行号。 */
function foldIsDroppable(write, lineIndex, lastListDelete, lastValueDelete) {
  if (write.role === "append") {
    const lastDelete = lastListDelete.get(write.physicalKey)
    return lastDelete !== undefined && lineIndex < lastDelete
  }
  if (write.role === "set") {
    const lastDelete = lastValueDelete.get(write.physicalKey)
    return lastDelete !== undefined && lineIndex < lastDelete
  }
  return false
}

/**
 * 镜像 session-fold.ts 的 prepareFold（判定字段逐条同值；本预览多算一个 bytesBefore 用于展示，
 * skip 的 reason 与 kind 口径不变）。返回 invalidLine 是该模式独有的诊断信息，不影响判定。
 */
function prepareFold(log) {
  if (!foldIsSupportedHeader(log.headerLine)) return { kind: "skip", reason: "unknown-format", invalidLine: 1 }
  const lines = log.lines
  const parsed = []
  for (let index = 0; index < lines.length; index++) {
    const writes = foldParseTransaction(lines[index])
    // 空行、半行、非白名单形状都在这里被挡下 —— 与上游 open 的口径一致，不猜字段。
    if (writes === null) return { kind: "skip", reason: "unknown-format", invalidLine: index + 2 }
    parsed.push(writes)
  }
  const lastListDelete = new Map()
  const lastValueDelete = new Map()
  for (let index = 0; index < parsed.length; index++) {
    for (const write of parsed[index]) {
      if (write.role !== "delete") continue
      const table = write.target === "list" ? lastListDelete : lastValueDelete
      table.set(write.physicalKey, index)
    }
  }
  const kept = []
  let droppedLines = 0
  let droppedWrites = 0
  for (let index = 0; index < lines.length; index++) {
    const writes = parsed[index]
    // 空数组行不算「全部可丢」（与 prepareFold 一致：删它零收益）。
    if (writes.length > 0 && writes.every(write => foldIsDroppable(write, index, lastListDelete, lastValueDelete))) {
      droppedLines += 1
      droppedWrites += writes.length
      continue
    }
    kept.push(lines[index])
  }
  if (droppedLines === 0) return { kind: "skip", reason: "nothing-to-reclaim", invalidLine: null }
  return {
    kind: "fold",
    invalidLine: null,
    linesBefore: lines.length + 1,
    linesAfter: kept.length + 1,
    droppedLines,
    droppedWrites,
    bytesBefore: utf8ByteLength(serializeCompleteLines(log.headerLine, lines)),
    bytesAfter: utf8ByteLength(serializeCompleteLines(log.headerLine, kept)),
  }
}

/**
 * 单个样本的折叠收益分析（纯计算，不写盘）。
 * fileBytes 必须来自 statSync(file).size —— 与 T5.02 闸门 1 的 fileInfo.size 同口径。
 * 非撕裂文件的规范形状逐字节等于文件本身，对不上说明口径错了：直接抛错，不打印不可信的数字。
 */
function analyzeFoldSample(text, fileBytes, samplePath) {
  const log = readFoldLog(text)
  const bytesBefore = utf8ByteLength(serializeCompleteLines(log.headerLine, log.lines))
  const bytesEqualsFileSize = !log.torn && bytesBefore === fileBytes
  if (!bytesEqualsFileSize && !log.torn) {
    throw new Error(
      `字节口径断言失败（${samplePath}）: bytesBefore=${bytesBefore} !== statSync(file).size=${fileBytes}；拒绝输出不可信的数字`,
    )
  }
  const plan = prepareFold(log)
  const bytesAfter = plan.kind === "fold" ? plan.bytesAfter : bytesBefore
  const reclaimBytes = bytesBefore - bytesAfter
  const reclaimRatio = bytesBefore > 0 ? reclaimBytes / bytesBefore : 0
  // 三闸门（字节口径，三者 AND）；与 T5.02 步骤 7 的式子一致：reclaimed < before × ratio 即不重写。
  // unknown-format 时根本没有折叠计划，闸门 2/2b 的前提不成立：只报闸门 1，不拿 0 冒充「可回收量」。
  const gates = [
    {
      id: "minFileBytes",
      limit: FOLD_POLICY.minFileBytes,
      value: fileBytes,
      passed: fileBytes > FOLD_POLICY.minFileBytes,
    },
  ]
  if (plan.reason !== "unknown-format") {
    gates.push(
      {
        id: "minReclaimBytes",
        limit: FOLD_POLICY.minReclaimBytes,
        value: reclaimBytes,
        passed: reclaimBytes >= FOLD_POLICY.minReclaimBytes,
      },
      {
        id: "minReclaimRatio",
        limit: FOLD_POLICY.minReclaimRatio,
        value: reclaimRatio,
        passed: reclaimRatio >= FOLD_POLICY.minReclaimRatio,
      },
    )
  }
  const blockedBy = gates.filter(gate => !gate.passed).map(gate => gate.id)
  const foldable = plan.kind === "fold" && blockedBy.length === 0
  const conclusion =
    plan.kind === "skip"
      ? `不会被折叠（prepareFold 跳过：${plan.reason}${plan.invalidLine === null ? "" : `，首个不合法行 = 第 ${plan.invalidLine} 行`}）`
      : foldable
        ? "会被折叠（prepareFold=fold，且三个闸门 AND 全过）"
        : `不会被折叠（未通过闸门: ${blockedBy.join(" / ")}）`
  return {
    path: samplePath,
    fileBytes,
    bytesEqualsFileSize,
    torn: log.torn,
    kind: plan.kind,
    skipReason: plan.kind === "skip" ? plan.reason : null,
    invalidLine: plan.invalidLine ?? null,
    linesBefore: plan.kind === "fold" ? plan.linesBefore : log.lines.length + 1,
    linesAfter: plan.kind === "fold" ? plan.linesAfter : log.lines.length + 1,
    droppedLines: plan.kind === "fold" ? plan.droppedLines : 0,
    droppedWrites: plan.kind === "fold" ? plan.droppedWrites : 0,
    bytesBefore,
    bytesAfter,
    reclaimBytes,
    reclaimRatio,
    gates,
    blockedBy,
    foldable,
    conclusion,
  }
}

function buildFoldPreview(samples) {
  return {
    policy: {
      minFileBytes: FOLD_POLICY.minFileBytes,
      minReclaimBytes: FOLD_POLICY.minReclaimBytes,
      minReclaimRatio: FOLD_POLICY.minReclaimRatio,
      sourceOfTruth: "src/services/engine/harness/session-fold.ts:FOLD_POLICY",
    },
    samples: samples.map(sample => analyzeFoldSample(sample.text, sample.bytes, sample.path)),
  }
}

function renderFoldGate(gate) {
  if (gate.id === "minFileBytes") {
    return `      闸门 1 minFileBytes（口径 = statSync(file).size，T5.02 的一次 stat）：文件 ${gate.value} B ${gate.passed ? ">" : "≤"} ${gate.limit} B → ${gate.passed ? "通过" : "未通过"}`
  }
  if (gate.id === "minReclaimBytes") {
    return `      闸门 2 minReclaimBytes（可回收 = bytesBefore - bytesAfter）：可回收 ${gate.value} B ${gate.passed ? "≥" : "<"} ${gate.limit} B → ${gate.passed ? "通过" : "未通过"}`
  }
  return `      闸门 2b minReclaimRatio（与 T5.02 同式：reclaimed < bytesBefore × ratio 即不重写）：可回收比例 ${fixed(gate.value, 4)} ${gate.passed ? "≥" : "<"} ${gate.limit} → ${gate.passed ? "通过" : "未通过"}`
}

function renderFoldPreview(foldPreview) {
  const out = []
  out.push("[frame-stats] --fold-preview（判定同源 src/services/engine/harness/session-fold.ts 的 prepareFold；只用于 O-6 选阈值，不作门禁证据）")
  out.push(
    `  FOLD_POLICY（唯一可调点在 session-fold.ts，本脚本是只读镜像）: minFileBytes=${FOLD_POLICY.minFileBytes} B（512 KiB） · minReclaimBytes=${FOLD_POLICY.minReclaimBytes} B（128 KiB） · minReclaimRatio=${FOLD_POLICY.minReclaimRatio}（字节口径，三者 AND）`,
  )
  for (const sample of foldPreview.samples) {
    out.push(`  ${sample.path}`)
    out.push(
      `    文件字节(statSync)=${sample.fileBytes} · 完整行=${sample.linesBefore} · 撕裂=${sample.torn} · bytesBefore 校验=${
        sample.bytesEqualsFileSize ? `${sample.bytesBefore} === ${sample.fileBytes}` : "n/a（撕裂文件只保证 ≤）"
      }`,
    )
    if (sample.kind === "fold" || sample.skipReason === "nothing-to-reclaim") {
      out.push(
        `    bytesBefore=${sample.bytesBefore} droppedLines=${sample.droppedLines} linesAfter=${sample.linesAfter} bytesAfter=${sample.bytesAfter} droppedWrites=${sample.droppedWrites} linesBefore=${sample.linesBefore} reclaimRatio=${fixed(sample.reclaimRatio, 4)}`,
      )
    } else {
      out.push(
        `    prepareFold 判定: skip（${sample.skipReason}）· 首个不合法行 = 第 ${sample.invalidLine} 行（本文件一行都不可动）`,
      )
    }
    for (const gate of sample.gates) out.push(renderFoldGate(gate))
    if (sample.skipReason === "unknown-format") {
      out.push("      闸门 2 minReclaimBytes / 闸门 2b minReclaimRatio: 不适用（没有折叠计划，无从计算可回收量）")
    }
    out.push(`    结论: ${sample.conclusion}`)
    out.push("    注: 本预览只对照 FOLD_POLICY 三闸门；T5.02 步骤 8 的 MAX_TOOL_FILE_BYTES 上限守卫不在对照范围内")
  }
  return out.join("\n")
}

// ── 样本解析 ──

function collectJsonl(dir) {
  if (!existsSync(dir)) return []
  const found = []
  // 用 Dirent 判定，不跟随符号链接：只读工具不该因为数据根里的链接绕圈。
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...collectJsonl(full))
    else if (entry.name.endsWith(".jsonl")) found.push(full)
  }
  return found
}

/** 位置参数优先；否则在 --root（缺省为项目内数据根）下取 mtime 最新的 .jsonl。 */
function resolveSamples(options) {
  if (options.paths.length > 0) return { root: null, candidates: [...new Set(options.paths.map(path => resolve(path)))] }
  const root = options.root ? resolve(options.root) : DEFAULT_ROOT
  const all = collectJsonl(root)
  if (all.length === 0) return { root, candidates: [] }
  const newest = all.map(file => ({ file, mtimeMs: statSync(file).mtimeMs })).sort((a, b) => b.mtimeMs - a.mtimeMs)[0].file
  return { root, candidates: [newest] }
}

function exitNoSamples(root, candidates, dropped) {
  console.error("[frame-stats] 没有可用样本：找不到任何非空的 .jsonl 会话文件，不输出任何数字。")
  const rootLabel = root === null ? "（位置参数）" : `${root}${existsSync(root) ? "" : "（该目录不存在）"}`
  console.error(`  找的是: ${rootLabel}`)
  for (const file of candidates) console.error(`  传入的路径: ${file}`)
  for (const drop of dropped) console.error(`  被跳过: ${drop.path}（${drop.reason}）`)
  console.error("  可操作提示:")
  console.error("    · 用 `--root <会话根>` 指定其它数据根（例如 --root data/desk-pet/sessions）")
  console.error("    · 或把 .jsonl 会话文件路径直接作为位置参数传入")
  console.error("    · 想先验证算法本身（不依赖用户数据）: node scripts/session-frame-stats.mjs --selftest")
  process.exitCode = 2
}

// ── 自检（合成样本，只写系统 temp）──

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`selftest 失败: ${label}，期望 ${expected}，实际 ${actual}`)
}

function buildSelftestLines() {
  const frame = (seq, key, delta) =>
    JSON.stringify({ kind: "list", op: "append", seq, namespace: FRAME_NAMESPACE, key, value: { type: "text_delta", contentIndex: 0, delta } })
  return [
    JSON.stringify({ v: 4, kind: "header", id: "selftest", storageVersion: 1, createdAt: 0, cwd: "/tmp" }),
    JSON.stringify({ kind: "entry", id: "entry-user-a", parentId: null, type: "message", message: { role: "user", content: "hi" }, seq: 1, timestamp: 1000 }),
    frame(2, "op-1:entry-assistant-a", "a"),
    frame(3, "op-1:entry-assistant-a", "b"),
    JSON.stringify([
      { kind: "entry", id: "entry-assistant-a", parentId: "entry-user-a", type: "message", message: { role: "assistant", content: "ok" }, seq: 4, timestamp: 1500 },
      { kind: "list", op: "delete", seq: 5, namespace: FRAME_NAMESPACE, key: "op-1:entry-assistant-a" },
      { kind: "value", op: "set", seq: 6, namespace: "pi.lane.state", key: "main", value: { currentOperationId: null } },
    ]),
    JSON.stringify({ kind: "entry", id: "entry-user-b", parentId: "entry-assistant-a", type: "message", message: { role: "user", content: "again" }, seq: 7, timestamp: 2000 }),
    frame(8, "op-2:entry-assistant-b", "x"),
    frame(9, "op-2:entry-assistant-b", "y"),
    frame(10, "op-2:entry-assistant-b", "z"),
    JSON.stringify({ kind: "entry", id: "entry-assistant-b", parentId: "entry-user-b", type: "message", message: { role: "assistant", content: "done" }, seq: 11, timestamp: 3000 }),
  ]
}

// --fold-preview 的合成样本构造（只进系统 temp 与内存，不碰用户数据）。
const foldHeaderLine = JSON.stringify({ v: 4, kind: "header", storageVersion: 1, id: "selftest-fold", createdAt: 0, cwd: "/tmp" })
const foldFrameWrite = (seq, key, delta) => ({ kind: "list", op: "append", seq, namespace: FRAME_NAMESPACE, key, value: { type: "text_delta", contentIndex: 0, delta } })
const foldDeleteWrite = (seq, key) => ({ kind: "list", op: "delete", seq, namespace: FRAME_NAMESPACE, key })
const foldEntryWrite = (id, seq, timestamp, content) => ({ kind: "entry", id, parentId: null, type: "message", message: { role: "assistant", content }, seq, timestamp })
const foldValueSetWrite = (seq, namespace, key, value) => ({ kind: "value", op: "set", seq, namespace, key, value })
const foldValueDeleteWrite = (seq, namespace, key) => ({ kind: "value", op: "delete", seq, namespace, key })

/**
 * 15 行（含 header）的折叠样本，覆盖四条边界：
 *   · 死 key 的 append 要丢（index 2、3）；delete 行与含 entry 的多写行要留（index 4、10）；
 *   · list 与 value 是两张独立的表（index 5 的 value/set 与 index 2 的 append 同物理 key，
 *     但 value 表没有 delete ⇒ 必须留下）；
 *   · 「最后一次 delete 之后又被 append」的 key 不能误判（index 11）；
 *   · 整行多写且全部可丢要整行丢、按写数计（index 12，droppedWrites 因此是 6 而不是 5）；
 *   · index 8 含中文，钉住「字节 ≠ String.length」的口径。
 */
function buildFoldSelftestLines() {
  const frameKeyA = "op-1:entry-assistant-a"
  const frameKeyB = "op-2:entry-assistant-b"
  const frameKeyC = "op-3:entry-assistant-c"
  const frameKeyD = "op-4:entry-assistant-d"
  return [
    foldHeaderLine,                                                                          // 0 header
    JSON.stringify(foldEntryWrite("entry-user-a", 1, 1000, "hi")),                            // 1 keep
    JSON.stringify(foldFrameWrite(2, frameKeyA, "a")),                                        // 2 drop
    JSON.stringify(foldFrameWrite(3, frameKeyA, "b")),                                        // 3 drop
    JSON.stringify(foldDeleteWrite(4, frameKeyA)),                                            // 4 keep（delete 行）
    JSON.stringify(foldValueSetWrite(5, FRAME_NAMESPACE, frameKeyA, { doomed: true })),       // 5 keep（value 表无 delete）
    JSON.stringify(foldValueSetWrite(6, "pi.lane.state", "main", { currentOperationId: null })), // 6 drop
    JSON.stringify(foldValueDeleteWrite(7, "pi.lane.state", "main")),                         // 7 keep
    JSON.stringify(foldEntryWrite("entry-assistant-a", 8, 1500, "中文正文：这条保留行必须按 UTF-8 字节计")),  // 8 keep（中文）
    JSON.stringify(foldFrameWrite(9, frameKeyB, "x")),                                        // 9 drop（delete 在 10）
    JSON.stringify([
      foldEntryWrite("entry-assistant-b", 10, 2000, "ok"),
      foldDeleteWrite(11, frameKeyB),
      foldValueSetWrite(12, "pi.lane.state", "side", { currentOperationId: null }),
    ]),                                                                                       // 10 keep（多写行含 entry/delete）
    JSON.stringify(foldFrameWrite(13, frameKeyB, "y")),                                       // 11 keep（最后一次 delete 之后）
    JSON.stringify([foldFrameWrite(14, frameKeyD, "p"), foldFrameWrite(15, frameKeyD, "q")]), // 12 drop（整行两写）
    JSON.stringify(foldDeleteWrite(16, frameKeyD)),                                           // 13 keep
    JSON.stringify(foldFrameWrite(17, frameKeyC, "z")),                                       // 14 keep（该 key 从未 delete）
  ]
}

/** 合成文本不落盘：Buffer.byteLength(text) 就是它写到盘上的字节数（与 statSync(file).size 同值）。 */
function analyzeFoldSynthetic(lines, name) {
  const text = `${lines.join("\n")}\n`
  return analyzeFoldSample(text, Buffer.byteLength(text, "utf8"), `synthetic://${name}`)
}

function runSelftest(json) {
  const dir = mkdtempSync(join(tmpdir(), "deskpet-frame-stats-"))
  const file = join(dir, "synthetic.jsonl")
  const lines = buildSelftestLines()
  const fd = openSync(file, "w")
  try {
    writeSync(fd, `${lines.join("\n")}\n`)
  } finally {
    closeSync(fd)
  }
  const checks = []
  try {
    const text = readFileSync(file, "utf8")
    const parsedLines = splitLines(text)

    // 展开：header 跳过；数组行展开成 3 条写，其中 list/delete 只有展开后才看得见。
    const { writes, unparsedLines } = expandTransactions(parsedLines)
    assertEqual(parsedLines.length, 10, "行数（含 header）")
    assertEqual(writes.length, 11, "展开后写条数")
    assertEqual(unparsedLines, 0, "无法解析行")
    assertEqual(writes[0].kind, "entry", "header 必须被跳过")
    assertEqual(writes.filter(write => write.op === "delete").length, 1, "数组行里的 list/delete 必须被展开出来")
    checks.push("expandTransactions: 11 条写（含数组行展开出的 1 条 list/delete）")

    // 帧判别：只认结构，且不做子串匹配。
    const frames = frameAppends(writes)
    assertEqual(frames.length, 5, "帧 append 数")
    assertEqual(frameAppends([{ kind: "list", op: "delete", seq: 5, namespace: FRAME_NAMESPACE, key: "op-1:entry-assistant-a" }]).length, 0, "同命名空间的 delete 不能算帧")
    checks.push("frameAppends: 5（delete 不算帧）")

    // 时长锚点：组 1 = 1500-1000；组 2 = 3000-2000（起始锚点是小于最小 seq 的最大 entry，即 user-b 而非 assistant-a）。
    const groups = responseDurations(parsedLines)
    assertEqual(groups.length, 2, "帧组数")
    const byEntry = new Map(groups.map(group => [group.responseEntryId, group]))
    assertEqual(byEntry.get("entry-assistant-a").appends, 2, "组 1 append 数")
    assertEqual(byEntry.get("entry-assistant-a").durationMs, 500, "组 1 时长")
    assertEqual(byEntry.get("entry-assistant-a").anchorEntryId, "entry-user-a", "组 1 起始锚点")
    assertEqual(byEntry.get("entry-assistant-b").appends, 3, "组 2 append 数")
    assertEqual(byEntry.get("entry-assistant-b").durationMs, 1000, "组 2 时长")
    assertEqual(byEntry.get("entry-assistant-b").anchorEntryId, "entry-user-b", "组 2 起始锚点")
    assertEqual(byEntry.get("entry-assistant-a").perSecond, 4, "组 1 速率")
    assertEqual(byEntry.get("entry-assistant-b").perSecond, 3, "组 2 速率")
    checks.push("responseDurations: 2 组 / 500ms + 1000ms / 4.0 + 3.0 次/秒 / 锚点法命中")

    // 合成样本上的整链汇总。
    const summary = summarize(text, Buffer.byteLength(text, "utf8"), file)
    assertEqual(summary.frameAppends, 5, "合计帧 append")
    assertEqual(summary.durationMs, 1500, "合计时长")
    assertEqual(summary.avgPerSecond.toFixed(4), (5 / 1.5).toFixed(4), "平均速率")
    assertEqual(summary.peakGroup.perSecond, 4, "峰值速率")
    assertEqual(summary.reclaimableAppends, 2, "可回收 append（已 delete 的 key）")
    assertEqual(summary.reclaimableAppends / summary.lines, 2 / 10, "可回收行占比")
    const frameBytes = lines.slice(2, 4).concat(lines.slice(6, 9)).reduce((total, line) => total + Buffer.byteLength(line, "utf8") + 1, 0)
    assertEqual(summary.frameBytes, frameBytes, "帧字节（含行尾换行）")
    checks.push("summarize: 合计 5 帧 / 1.5 s / 平均 3.3 次/秒 / 可回收 2 行 / 帧字节含换行")

    // 缓冲模拟：1 B 阈值 → 每个帧都体积触发；1 MiB 阈值 → 只有非帧行清空。
    const eager = simulateBuffer(parsedLines, 1)
    assertEqual(eager.volumeFlushes, 5, "1 B 阈值的体积触发")
    assertEqual(eager.nonFrameFlushes, 0, "1 B 阈值的非帧触发")
    assertEqual(eager.mergedPerFlush, 1, "1 B 阈值的合并帧/次")
    // 1 B 阈值下每条帧各自触发 flush，没有跨帧合并 → 5 帧写成 5 行。
    assertEqual(eager.writtenRows, 5, "1 B 阈值的落盘行数（不跨 flush 合并）")
    const lazy = simulateBuffer(parsedLines, 1024 * 1024)
    assertEqual(lazy.volumeFlushes, 0, "1 MiB 阈值的体积触发")
    assertEqual(lazy.nonFrameFlushes, 2, "1 MiB 阈值的非帧触发")
    assertEqual(lazy.mergedPerFlush, 2.5, "1 MiB 阈值的合并帧/次")
    // 同键 delta 合并：组 1 的 2 帧合成 1 行（"ab"）、组 2 的 3 帧合成 1 行（"xyz"）。
    assertEqual(lazy.writtenRows, 2, "1 MiB 阈值的落盘行数（5 帧 → 2 行）")
    assertEqual(lazy.rowsPerFlush, 1, "1 MiB 阈值的落盘行/次（2 次 flush 各 1 行）")
    checks.push("simulateBuffer: 1 B → 5 次 flush / 5 行；1 MiB → 2 次 flush / 2 行（同键 2+3 帧各合 1 行）")

    // 合并边界：同一槽位的 delta 不得跨非 delta 帧（text_end 是覆盖语义）合并成一行。
    const boundaryKey = "op-b:resp-b"
    const boundaryFrame = (seq, delta) =>
      JSON.stringify({ kind: "list", op: "append", seq, namespace: FRAME_NAMESPACE, key: boundaryKey, value: { type: "text_delta", contentIndex: 0, delta } })
    const boundary = simulateBuffer(
      [
        JSON.stringify({ v: 4, kind: "header", id: "selftest-boundary", storageVersion: 1, createdAt: 0, cwd: "/tmp" }),
        boundaryFrame(1, "a"),
        boundaryFrame(2, "b"),
        JSON.stringify({ kind: "list", op: "append", seq: 3, namespace: FRAME_NAMESPACE, key: boundaryKey, value: { type: "text_end", contentIndex: 0, content: "ab" } }),
        boundaryFrame(4, "c"),
      ],
      1024 * 1024,
    )
    assertEqual(boundary.writtenRows, 3, "跨非 delta 帧必须切行（2 行合并 delta + 1 行 text_end）")
    assertEqual(boundary.mergedFrames, 4, "边界切分只切行：原帧数一个不少（3 delta + 1 text_end）")
    checks.push("simulateBuffer: delta→text_end→delta 切成 3 行（不跨覆盖语义边界合并）")

    // --fold-preview：合成样本（含中文）走与真实文件相同的入口，钉住折叠口径与 UTF-8 字节口径。
    const foldLines = buildFoldSelftestLines()
    const foldText = `${foldLines.join("\n")}\n`
    const foldFile = join(dir, "synthetic-fold.jsonl")
    const foldFd = openSync(foldFile, "w")
    try {
      writeSync(foldFd, foldText)
    } finally {
      closeSync(foldFd)
    }
    const fold = analyzeFoldSample(foldText, statSync(foldFile).size, foldFile)
    assertEqual(fold.droppedLines, 5, "fold 丢弃行数")
    assertEqual(fold.droppedWrites, 6, "fold 丢弃写条数（含一条整行两写的多写行）")
    assertEqual(fold.linesBefore, 15, "fold 完整行数（含 header）")
    assertEqual(fold.linesAfter, 10, "fold 保留行数（含 header）")
    assertEqual(fold.bytesBefore, statSync(foldFile).size, "fold bytesBefore === statSync(file).size")
    assertEqual(fold.bytesEqualsFileSize, true, "fold 字节口径断言（非撕裂文件必须逐字节相等）")
    // bytesAfter 用「原字节 - 被删行的字节（含行尾换行）」独立重算，不经过被测算的实现。
    const droppedByteTotal = [2, 3, 6, 9, 12].reduce((total, index) => total + Buffer.byteLength(foldLines[index], "utf8") + 1, 0)
    assertEqual(fold.bytesAfter, fold.bytesBefore - droppedByteTotal, "fold bytesAfter = 原字节 - 被删行字节")
    assertEqual(foldLines[8].includes("中文正文"), true, "样本必须含中文行")
    assertEqual(fold.bytesBefore > foldText.length, true, "中文样本：UTF-8 字节必须大于 String.length（口径分叉）")
    assertEqual(fold.kind, "fold", "小样本仍应产出 fold 计划")
    assertEqual(fold.foldable, false, "小文件不会被折叠")
    // 小文件同时过不了闸门 1（体量）与闸门 2（3 KB 的文件不可能回收 128 KiB），但比例闸门过。
    assertEqual(fold.blockedBy.join(","), "minFileBytes,minReclaimBytes", "小文件由闸门 1（以及绝对回收量）拦下")
    checks.push("foldPreview: 合成 15 行含中文 → 丢 5 行 / 6 写、保留 9 行；bytesBefore===文件字节；bytesAfter 与逐行重算一致")

    // 阈值方向：三闸门都各有一个「单独拦下」的合成样本，最后一个是病灶形态（会被折叠）。
    const lesionKey = "op-big:entry-assistant-big"
    const lesion = analyzeFoldSynthetic(
      [
        foldHeaderLine,
        JSON.stringify(foldEntryWrite("entry-user-big", 1, 1000, "开始")),
        ...Array.from({ length: 6200 }, (_, index) => JSON.stringify(foldFrameWrite(2 + index, lesionKey, `中文增量内容片段${index}`))),
        JSON.stringify(foldEntryWrite("entry-assistant-big", 7000, 2000, "结束")),
        JSON.stringify(foldDeleteWrite(7001, lesionKey)),
      ],
      "lesion",
    )
    assertEqual(lesion.fileBytes > FOLD_POLICY.minFileBytes, true, "病灶形态必须过闸门 1")
    assertEqual(lesion.droppedLines, 6200, "病灶形态丢弃行数")
    assertEqual(lesion.linesAfter, 4, "病灶形态保留行数")
    assertEqual(lesion.foldable, true, "病灶形态会被折叠")
    assertEqual(lesion.blockedBy.length, 0, "病灶形态三闸门全过")

    const lowReclaimKey = "op-low:entry-assistant-low"
    const lowReclaim = analyzeFoldSynthetic(
      [
        foldHeaderLine,
        JSON.stringify(foldEntryWrite("entry-fat", 1, 1000, "x".repeat(450 * 1024))),
        ...Array.from({ length: 480 }, (_, index) => JSON.stringify(foldFrameWrite(2 + index, lowReclaimKey, `增量${index}`))),
        JSON.stringify(foldEntryWrite("entry-assistant-low", 900, 2000, "ok")),
        JSON.stringify(foldDeleteWrite(901, lowReclaimKey)),
      ],
      "low-reclaim",
    )
    assertEqual(lowReclaim.fileBytes > FOLD_POLICY.minFileBytes, true, "低回收样本必须过闸门 1")
    assertEqual(lowReclaim.reclaimBytes < FOLD_POLICY.minReclaimBytes, true, "低回收样本的可回收字节必须低于闸门 2")
    assertEqual(lowReclaim.reclaimRatio >= FOLD_POLICY.minReclaimRatio, true, "低回收样本的比例必须过闸门 2b（只留闸门 2 拦它）")
    assertEqual(lowReclaim.blockedBy.join(","), "minReclaimBytes", "低回收样本由闸门 2 拦下")
    assertEqual(lowReclaim.foldable, false, "低回收样本不会被折叠")

    const ratioKey = "op-ratio:entry-assistant-ratio"
    const lowRatio = analyzeFoldSynthetic(
      [
        foldHeaderLine,
        JSON.stringify(foldEntryWrite("entry-wide", 1, 1000, "x".repeat(970 * 1024))),
        ...Array.from({ length: 800 }, (_, index) => JSON.stringify(foldFrameWrite(2 + index, ratioKey, `中文增量内容片段${index}`))),
        JSON.stringify(foldEntryWrite("entry-assistant-ratio", 1200, 2000, "ok")),
        JSON.stringify(foldDeleteWrite(1201, ratioKey)),
      ],
      "low-ratio",
    )
    assertEqual(lowRatio.fileBytes > FOLD_POLICY.minFileBytes, true, "低比例样本必须过闸门 1")
    assertEqual(lowRatio.reclaimBytes >= FOLD_POLICY.minReclaimBytes, true, "低比例样本的可回收字节必须过闸门 2")
    assertEqual(lowRatio.reclaimRatio < FOLD_POLICY.minReclaimRatio, true, "低比例样本的比例必须低于闸门 2b")
    assertEqual(lowRatio.blockedBy.join(","), "minReclaimRatio", "低比例样本由闸门 2b 拦下")
    assertEqual(lowRatio.foldable, false, "低比例样本不会被折叠")
    checks.push("foldPreview 阈值方向: 小文件→闸门 1 / 回收不足→闸门 2 / 比例不足→闸门 2b / 病灶形态 6200 行中文→会被折叠")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  if (json) {
    console.log(JSON.stringify({ kind: "selftest", ok: true, checks }, null, 2))
  } else {
    console.log(`[frame-stats] selftest（合成样本，只写系统 temp）`)
    for (const check of checks) console.log(`  ${check}`)
    console.log("selftest ok")
  }
  return 0
}

// ── CLI ──

function parseArgs(argv) {
  const options = { paths: [], root: null, calibrate: false, foldPreview: false, json: false, selftest: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--root") {
      const value = argv[++index]
      if (!value) throw new Error(`--root 需要一个目录参数\n${USAGE}`)
      options.root = value
    } else if (arg === "--calibrate") options.calibrate = true
    else if (arg === "--fold-preview") options.foldPreview = true
    else if (arg === "--json") options.json = true
    else if (arg === "--selftest") options.selftest = true
    else if (arg.startsWith("-")) throw new Error(`未知参数 ${arg}\n${USAGE}`)
    else options.paths.push(arg)
  }
  return options
}

function buildReport(samples) {
  const summaries = samples.map(sample => summarize(sample.text, sample.bytes, sample.path))
  const totals = mergeSamples(summaries)
  return {
    tool: "scripts/session-frame-stats.mjs",
    samples: summaries.map(summary => ({
      path: summary.path,
      bytes: summary.bytes,
      lines: summary.lines,
      writes: summary.writes,
      unparsedLines: summary.unparsedLines,
      frameAppends: summary.frameAppends,
      frameBytes: summary.frameBytes,
      reclaimableAppends: summary.reclaimableAppends,
      frameGroups: summary.frames.length,
      durationMs: summary.durationMs,
      avgPerSecond: summary.avgPerSecond,
      peakPerSecond: summary.peakGroup?.perSecond ?? null,
    })),
    totals: {
      bytes: totals.bytes,
      lines: totals.lines,
      writes: totals.writes,
      unparsedLines: totals.unparsedLines,
      frameAppends: totals.frameAppends,
      frameBytes: totals.frameBytes,
      frameByteRatio: totals.frameByteRatio,
      reclaimableAppends: totals.reclaimableAppends,
      reclaimableLineRatio: totals.reclaimableLineRatio,
      deletedFrameKeys: totals.deletedFrameKeys,
      frameGroups: totals.frameGroups,
      framesWithoutDuration: totals.framesWithoutDuration,
      durationMs: totals.durationMs,
      durationSeconds: totals.durationSeconds,
      avgPerSecond: totals.avgPerSecond,
      peakPerSecond: totals.peakPerSecond,
      peakResponseEntryId: totals.peakResponseEntryId,
      peakAppends: totals.peakAppends,
      histogram: Object.fromEntries(sortedHistogram(totals.histogram)),
    },
    frames: totals.frames,
  }
}

/**
 * 阈值扫描表。每个阈值都跑「每文件一个缓冲」的模拟，跨文件求和。
 * 落盘调用速率 = flush 次数 / 样本总时长；相对基线 = 样本平均帧速率 / 落盘调用速率。
 */
function buildCalibration(samples, baselinePerSecond, durationSeconds) {
  return CALIBRATION_THRESHOLDS_KIB.map(kib => {
    const thresholdBytes = kib * 1024
    let volumeFlushes = 0
    let nonFrameFlushes = 0
    let trailingFlushes = 0
    let flushes = 0
    let mergedFrames = 0
    let writtenRows = 0
    for (const sample of samples) {
      const row = simulateBuffer(sample.lines, thresholdBytes)
      volumeFlushes += row.volumeFlushes
      nonFrameFlushes += row.nonFrameFlushes
      trailingFlushes += row.trailingFlushes
      flushes += row.flushes
      mergedFrames += row.mergedFrames
      writtenRows += row.writtenRows
    }
    const flushPerSecond = durationSeconds > 0 ? flushes / durationSeconds : null
    return {
      thresholdKib: kib,
      thresholdBytes,
      flushes,
      volumeFlushes,
      nonFrameFlushes,
      trailingFlushes,
      mergedFrames,
      writtenRows,
      mergedPerFlush: flushes > 0 ? mergedFrames / flushes : null,
      rowsPerFlush: flushes > 0 ? writtenRows / flushes : null,
      flushPerSecond,
      ratioToBaseline: flushPerSecond !== null && flushPerSecond > 0 ? baselinePerSecond / flushPerSecond : null,
    }
  })
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`[frame-stats] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
    return
  }

  if (options.selftest) {
    process.exitCode = runSelftest(options.json)
    return
  }

  const { root, candidates } = resolveSamples(options)
  const samples = []
  const dropped = []
  for (const candidate of candidates) {
    if (!existsSync(candidate)) dropped.push({ path: candidate, reason: "不存在" })
    else if (statSync(candidate).size === 0) dropped.push({ path: candidate, reason: "空文件" })
    else {
      const text = readFileSync(candidate, "utf8")
      const lines = splitLines(text)
      if (lines.length === 0) dropped.push({ path: candidate, reason: "没有任何行" })
      else samples.push({ path: candidate, bytes: statSync(candidate).size, text, lines })
    }
  }
  if (samples.length === 0) {
    exitNoSamples(root, candidates, dropped)
    return
  }

  const report = buildReport(samples)
  if (report.totals.writes === 0) {
    // 有文件但一条事务写都没有：同样按「无样本」处理，不输出 0 值报告。
    exitNoSamples(root, candidates, dropped.concat(samples.map(sample => ({ path: sample.path, reason: "没有可解析的事务写" }))))
    return
  }

  const baseline = report.totals.avgPerSecond ?? 0
  if (options.foldPreview) {
    let foldPreview
    try {
      foldPreview = buildFoldPreview(samples)
    } catch (error) {
      console.error(`[frame-stats] ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 2
      return
    }
    report.foldPreview = foldPreview
    if (options.calibrate) report.calibration = buildCalibration(samples, baseline, report.totals.durationSeconds)
    if (options.json) {
      console.log(JSON.stringify(report, null, 2))
      return
    }
    const blocks = [renderFoldPreview(foldPreview)]
    if (report.calibration) blocks.push(renderCalibration(report.calibration, baseline))
    console.log(blocks.join("\n"))
    return
  }
  if (options.calibrate) {
    report.calibration = buildCalibration(samples, baseline, report.totals.durationSeconds)
    if (options.json) console.log(JSON.stringify(report, null, 2))
    else console.log(`${renderReport(report)}\n${renderCalibration(report.calibration, baseline)}`)
    return
  }

  if (options.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderReport(report))
}

main()
