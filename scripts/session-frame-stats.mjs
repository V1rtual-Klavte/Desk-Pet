#!/usr/bin/env node
// 会话帧写入基线复算（离线、只读、零依赖；不启动应用、不碰 IPC）。
//
// 三条必须随文件一起维护的约定：
// 1) 口径来源：源方案 §11.2《测量方法（可复现，供 W1 复用）》
//    docs/history/implementation/会话压缩与存储瘦身方案-2026-09-27基线.md
//    · 必须先把事务数组行展开成多条写（漏展开会丢 delete，曾据此误判「零删除」）；
//    · 帧的 key 是 `${operationId}:${responseEntryId}`，帧内没有 delta 级时间戳，
//      时长只能用锚点法：结束锚点 = id 等于 responseEntryId 的 entry 的 timestamp，
//      起始锚点 = 该帧组最小 seq 之前最近一条 entry 的 timestamp；不得改用别的锚点。
// 2) 样本：被 .gitignore 的运行时数据根（默认 data/desk-pet/sessions）里的会话 JSONL，
//    属用户数据 —— 本脚本只读，绝不改写、绝不删除；--selftest 的合成样本只写系统 temp。
// 3) --calibrate 的模拟规则必须与装饰器实现保持一致：每文件一个缓冲 / 体积触发 /
//    非帧触发清空（见 src/services/engine/pi/session-frame-buffer.ts，T1.01/T1.02）。
//    改装饰器的触发规则就要同步改这里的模拟，否则校准表立刻失真。
//
// 本目录是独立 Node CLI，直接用 console（与 scripts/live-test.mjs 同理：
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
const USAGE = "用法: node scripts/session-frame-stats.mjs [路径…] [--root <会话根>] [--calibrate] [--json] [--selftest]"

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
 * 体积阈值扫描：模拟「每文件一个缓冲 / 体积触发 / 非帧触发清空」（无定时器）。
 * 规则必须与 src/services/engine/pi/session-frame-buffer.ts 的 T1.01/T1.02 实现一致。
 * 缓冲字节 = 帧行 content 的实际字节数（含行尾换行）；非帧行只在缓冲非空时产生一次 flush。
 */
function simulateBuffer(lines, thresholdBytes) {
  let bufferedBytes = 0
  let bufferedFrames = 0
  let volumeFlushes = 0
  let nonFrameFlushes = 0
  let mergedFrames = 0
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
      bufferedBytes += Buffer.byteLength(line, "utf8") + 1
      bufferedFrames += 1
      if (bufferedBytes >= thresholdBytes) {
        volumeFlushes += 1
        mergedFrames += bufferedFrames
        bufferedBytes = 0
        bufferedFrames = 0
      }
      continue
    }
    if (bufferedFrames > 0) {
      nonFrameFlushes += 1
      mergedFrames += bufferedFrames
      bufferedBytes = 0
      bufferedFrames = 0
    }
  }
  // 文件结束时仍留在缓冲里的帧必须在关闭路径 flush（T1.04），否则会丢帧。
  const trailingFlushes = bufferedFrames > 0 ? 1 : 0
  if (trailingFlushes === 1) mergedFrames += bufferedFrames
  const flushes = volumeFlushes + nonFrameFlushes + trailingFlushes
  return {
    thresholdBytes,
    volumeFlushes,
    nonFrameFlushes,
    trailingFlushes,
    flushes,
    mergedFrames,
    mergedPerFlush: flushes > 0 ? mergedFrames / flushes : null,
  }
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
  out.push("O-5 阈值校准（模拟：每文件一个缓冲 / 体积触发 / 非帧触发清空；规则须与 session-frame-buffer.ts 一致）")
  out.push(`基线（样本实测平均）: ${fixed(baselinePerSecond, 1)} 次/秒`)
  out.push("")
  out.push(
    `  ${padDisplay("阈值", 10)}${padDisplay("flush 次数", 12)}${padDisplay("体积 / 非帧", 14)}${padDisplay("合并帧/次", 12)}${padDisplay("落盘调用速率", 16)}相对基线`,
  )
  for (const row of calibration) {
    const threshold = padDisplay(`${row.thresholdKib} KiB`, 10)
    const flushes = padDisplay(String(row.flushes), 12)
    const split = padDisplay(`${row.volumeFlushes} / ${row.nonFrameFlushes}${row.trailingFlushes > 0 ? " + 1 收尾" : ""}`, 14)
    const perFlush = padDisplay(fixed(row.mergedPerFlush, 1), 12)
    const rate = padDisplay(`${fixed(row.flushPerSecond, 2)} /s`, 16)
    const ratio = row.ratioToBaseline === null ? "n/a" : `${Math.round(row.ratioToBaseline)}×`
    out.push(`  ${threshold}${flushes}${split}${perFlush}${rate}${ratio}`)
  }
  out.push("")
  out.push("裁定（O-5）: 16 KiB —— 生产常量见 src/services/engine/pi/session-frame-buffer.ts（T1.01）；本脚本只是扫描器，不是定义点。")
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
    const lazy = simulateBuffer(parsedLines, 1024 * 1024)
    assertEqual(lazy.volumeFlushes, 0, "1 MiB 阈值的体积触发")
    assertEqual(lazy.nonFrameFlushes, 2, "1 MiB 阈值的非帧触发")
    assertEqual(lazy.mergedPerFlush, 2.5, "1 MiB 阈值的合并帧/次")
    checks.push("simulateBuffer: 1 B → 5（5/0）；1 MiB → 2（0/2）")
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
  const options = { paths: [], root: null, calibrate: false, json: false, selftest: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--root") {
      const value = argv[++index]
      if (!value) throw new Error(`--root 需要一个目录参数\n${USAGE}`)
      options.root = value
    } else if (arg === "--calibrate") options.calibrate = true
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
    for (const sample of samples) {
      const row = simulateBuffer(sample.lines, thresholdBytes)
      volumeFlushes += row.volumeFlushes
      nonFrameFlushes += row.nonFrameFlushes
      trailingFlushes += row.trailingFlushes
      flushes += row.flushes
      mergedFrames += row.mergedFrames
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
      mergedPerFlush: flushes > 0 ? mergedFrames / flushes : null,
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
