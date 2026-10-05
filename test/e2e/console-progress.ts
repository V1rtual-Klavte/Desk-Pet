// ==========================================
// Node 宿主（test/e2e Scene runner）的终端进度视图
// ==========================================
//
// 替换旧 WebView 宿主的窗口进度（progress.ts 的 DOM 视图）。两者共用同一套纯函数
// 模型：createProgressModel / renderSummary / statusIcon / formatDuration ——
// 本文件只把模型结果写成终端文本，不碰 DOM、不碰 IPC。
//
// 信息量与窗口视图对齐：顶部汇总（结束时打印）、逐 case 一行、失败行立即展开
// 断言差异（调用方把 formatSceneFailure/formatTraceEvents 的结果作为 detail 传入）。
// 本文件是测试工具，直接写 stdout；不进产品构建。

import { createProgressModel, formatDuration, renderSummary, statusIcon } from "./progress"
import type { CaseDetail, CaseDetailInput, FinishOutcome, ProgressView, SpecialProgressCell, SpecialProgressView, ProgressSummary } from "./progress"

function writeLine(line = ""): void {
  process.stdout.write(`${line}\n`)
}

function detailLines(detail?: CaseDetailInput): string[] {
  if (detail === undefined) return []
  if (typeof detail === "string") return [detail]
  if (Array.isArray(detail)) return [...(detail as readonly string[])]
  return [...(detail as CaseDetail).lines]
}

export interface ConsoleProgressOptions {
  /** 报告（本次运行产物）的绝对路径；结束语里回显。 */
  reportPath?: string
}

/** 场景进度视图：方法形状与 DOM 视图（ProgressView）一致，输出到终端。 */
export function createConsoleProgressView(total: number, options: ConsoleProgressOptions = {}): ProgressView {
  const model = createProgressModel(total)

  function label(key: string): string {
    // 行键就是「caseId（trial 1）+ #trial（repeat 时）」的唯一形状，直接回显即可。
    return key
  }

  function settledLine(icon: string, key: string, ms: number, suffix = ""): void {
    writeLine(`${icon} ${label(key)} ${formatDuration(ms)}${suffix}`)
  }

  return {
    plan(key, caseId, title) {
      // 计划行不逐条打印（60+ 场景 ×repeat 会淹没终端）；模型仍登记，汇总里可见总数。
      model.plan(key, caseId, title)
    },
    start(key, caseId, title) {
      model.start(key, title)
      writeLine(`▸ ${label(key)}${title ? ` ${title}` : ""}`)
    },
    pass(key, ms) {
      model.pass(key, ms)
      settledLine("✓", key, ms)
    },
    fail(key, ms, detail) {
      model.fail(key, ms, detail)
      settledLine("✗", key, ms)
      for (const line of detailLines(detail)) writeLine(`    ${line}`)
    },
    expectedFailure(key, ms) {
      model.expectedFailure(key, ms)
      settledLine("!", key, ms, " 预期失败")
    },
    skip(key, reason) {
      model.skip(key, reason)
      writeLine(`– ${label(key)} 跳过${reason ? `：${reason}` : ""}`)
    },
    finish(outcome: FinishOutcome) {
      model.finish()
      const summary: ProgressSummary = model.summary()
      writeLine("")
      writeLine(outcome.passed ? `结论：通过 (PASS)（${statusIcon("pass")}）` : "结论：失败 (FAIL)")
      if (outcome.note) writeLine(`说明：${outcome.note}`)
      writeLine(`报告：${options.reportPath ?? "未解析"}`)
      writeLine(renderSummary(summary))
    },
  }
}

export interface ConsoleSpecialProgressOptions {
  mode: string
  total: number
  /** 结果文件（本次运行产物）的绝对路径；结束语里回显。 */
  reportPath?: string
}

/**
 * 长跑模式（记忆质量 / 外部基准 / 记忆性能）的终端进度：与窗口版 SpecialProgressView
 * 同方法形状，逐 cell 一行摘要。
 */
export function createConsoleSpecialView(options: ConsoleSpecialProgressOptions): SpecialProgressView {
  const startedAt = Date.now()
  let pass = 0
  let fail = 0
  let skip = 0
  const started = new Map<string, { label: string; at: number }>()

  function counts(): string {
    return `${pass + fail + skip}/${options.total} · 通过 ${pass} · 失败 ${fail}`
      + (skip ? ` · 跳过 ${skip}` : "")
      + ` · ${formatDuration(Date.now() - startedAt)}`
  }

  return {
    begin(cell: SpecialProgressCell) {
      started.set(cell.key, { label: cell.label, at: Date.now() })
      writeLine(`▸ [${options.mode}] ${cell.label}`)
    },
    end(cell: { key: string; status: "pass" | "fail" | "skip"; note?: string }) {
      const entry = started.get(cell.key)
      const icon = cell.status === "pass" ? "✓" : cell.status === "fail" ? "✗" : "–"
      if (cell.status === "pass") pass += 1
      else if (cell.status === "fail") fail += 1
      else skip += 1
      writeLine(`${icon} [${options.mode}] ${entry?.label ?? cell.key} ${formatDuration(Date.now() - (entry?.at ?? startedAt))}${cell.note ? ` · ${cell.note}` : ""}`)
      writeLine(`  进度：${counts()}`)
    },
    finish(outcome: { verdict: "pass" | "pending" | "fail"; note?: string }) {
      writeLine("")
      writeLine(outcome.verdict === "pass" ? "结论：通过 (PASS)" : outcome.verdict === "pending" ? "结论：待审阅 (PENDING)" : "结论：失败 (FAIL)")
      if (outcome.note) writeLine(`说明：${outcome.note}`)
      writeLine(`结果文件：${options.reportPath ?? "未解析"}`)
      writeLine(`进度：${counts()}`)
    },
  }
}
