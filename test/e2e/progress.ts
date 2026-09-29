// ==========================================
// L4 宿主窗口的实时进度：状态模型 + DOM 视图
//
// 分界（本模块存在的理由）：
//   · 模型是纯函数 —— 状态迁移、计数、文案、失败详情整形，全在 createProgressModel
//     与几个 format*/render* 里，不碰 DOM、不碰 IPC，由 test/unit/progress.test.ts 覆盖；
//   · 视图只把模型算出来的结果写进 DOM —— 不可测也不必测，判据是窗口里能不能读懂
//     （契约「观测面」目标 1：失败立即展开断言差异与失败窗口的事件序列）。
//
// 本文件刻意不 import 任何产品模块：模型部分要能在 vitest（Node 环境）里直接跑。
// 「打开目录」这类桌面动作由宿主经 options 注入，视图自己没有 IPC 依赖。
// ==========================================

// ── 状态模型（纯函数，可测）──

/**
 * 每条 case（一次 trial 一行）的状态。
 *
 * `expected-failure` 是「通过，且回合里声明并命中了预期失败」的独立档：
 * 它不是失败，但也不能被读成「什么都没发生」—— 报告侧同样把两者分开记。
 */
export type CaseStatus = "pending" | "running" | "pass" | "fail" | "expected-failure" | "skip"

export interface CaseDetail {
  /** 失败详情：断言差异与失败窗口的事件序列，一行一条。由 format* 纯函数产出。 */
  lines: string[]
}

export interface CaseRow {
  /** 视图内唯一的行键（caseId 在 repeat>1 时会重复，行键要带 trial）。 */
  key: string
  caseId: string
  title: string
  status: CaseStatus
  durationMs: number
  detail?: CaseDetail
}

export interface ProgressSummary {
  total: number
  /** 已跑：实际执行过的行（通过 + 失败 + 预期失败）；跳过的不算执行。 */
  done: number
  passed: number
  failed: number
  expectedFailures: number
  skipped: number
  /** 剩余：既未执行也未跳过（超时后被记为 skip 的 trial 不在这里）。 */
  remaining: number
  /** 耗时：模型创建到 finish()（未结束时算到当前时刻）。 */
  durationMs: number
}

export type CaseDetailInput = string | readonly string[] | CaseDetail

export interface ProgressModel {
  /** 预登记一行（pending）。运行前把所有计划过的 trial 都摆出来，剩余才是看得见的。 */
  plan(key: string, caseId: string, title: string): void
  start(key: string, title?: string): void
  pass(key: string, ms: number): void
  fail(key: string, ms: number, detail?: CaseDetailInput): void
  expectedFailure(key: string, ms: number): void
  skip(key: string, reason?: string): void
  finish(): void
  summary(): ProgressSummary
  rows(): readonly CaseRow[]
}

function toDetail(detail?: CaseDetailInput): CaseDetail | undefined {
  if (detail === undefined) return undefined
  const lines = typeof detail === "string"
    ? [detail]
    : Array.isArray(detail)
      ? (detail as readonly string[]).slice()
      : (detail as CaseDetail).lines.slice()
  return lines.length > 0 ? { lines } : undefined
}

/**
 * 进度模型。
 *
 * `total` 是计划行数（= plannedTrials），不随事件增长；事件里的 key 可以超出它
 * （模型不替调用方保证一致性，只如实记），此时 `remaining` 夹在 0。
 * `now` 可注入，测试用它钉住耗时，不依赖真实时钟。
 */
export function createProgressModel(total: number, now: () => number = Date.now): ProgressModel {
  const startedAt = now()
  let finishedAt: number | undefined
  const order: string[] = []
  const byKey = new Map<string, CaseRow>()

  function ensure(key: string, caseId = key, title = ""): CaseRow {
    const existing = byKey.get(key)
    if (existing) return existing
    const row: CaseRow = { key, caseId, title, status: "pending", durationMs: 0 }
    byKey.set(key, row)
    order.push(key)
    return row
  }

  function settle(key: string, status: CaseStatus, ms: number, detail?: CaseDetailInput): void {
    const row = ensure(key)
    row.status = status
    row.durationMs = ms
    const normalized = toDetail(detail)
    if (normalized) row.detail = normalized
  }

  return {
    plan(key, caseId, title) { ensure(key, caseId, title) },
    start(key, title) {
      const row = ensure(key)
      row.status = "running"
      if (title !== undefined) row.title = title
    },
    pass(key, ms) { settle(key, "pass", ms) },
    fail(key, ms, detail) { settle(key, "fail", ms, detail) },
    expectedFailure(key, ms) { settle(key, "expected-failure", ms) },
    skip(key, reason) { settle(key, "skip", 0, reason) },
    finish() { finishedAt = now() },
    summary() {
      const rows = order.map(key => byKey.get(key)!)
      const passed = rows.filter(row => row.status === "pass").length
      const failed = rows.filter(row => row.status === "fail").length
      const expectedFailures = rows.filter(row => row.status === "expected-failure").length
      const skipped = rows.filter(row => row.status === "skip").length
      const done = passed + failed + expectedFailures
      return {
        total,
        done,
        passed,
        failed,
        expectedFailures,
        skipped,
        remaining: Math.max(0, total - done - skipped),
        durationMs: (finishedAt ?? now()) - startedAt,
      }
    },
    rows() { return order.map(key => byKey.get(key)!) },
  }
}

// ── 详情整形（纯函数，可测）──

/** 一次失败最多展示几行断言差异；再多会让窗口里的重点淹掉。 */
const MAX_FAILURE_LINES = 20
/** 事件序列每行最多保留多少字符的 payload。 */
const MAX_EVENT_PAYLOAD = 160
/** 窗口里保留多少条运行期事件（失败窗口的「现场」）。 */
export const TRACE_WINDOW_SIZE = 40

/**
 * `SceneResult` 的结构子集。
 *
 * 只声明整形真正读到的字段，不 import `./types`：进度模块保持零依赖，
 * `SceneResult` 由结构类型自动兼容。
 */
export interface FailureSource {
  error?: string
  errorKind?: string
  turns: readonly {
    index: number
    description: string
    errorKind?: string
    assertions: readonly {
      type: string
      pass: boolean
      error?: string
      expected?: string
      actual?: string
    }[]
  }[]
}

/** 失败原因：每条失败断言一行「期望 / 实际」，再加回合级与场景级错误。 */
export function formatSceneFailure(result: FailureSource): string[] {
  const lines: string[] = []
  for (const turn of result.turns) {
    let firstFailure = true
    for (const assertion of turn.assertions) {
      if (assertion.pass) continue
      const diff = assertion.expected !== undefined || assertion.actual !== undefined
        ? `（期望 ${assertion.expected ?? "?"}；实际 ${assertion.actual ?? "?"}）`
        : ""
      // 回合描述只贴在第一个失败断言上，同一回合的多条失败才不会被读成一串独立回合。
      lines.push(`${firstFailure ? `T${turn.index} ${turn.description}` : `T${turn.index}`} → ${assertion.type}: ${assertion.error ?? "断言未通过"}${diff}`)
      firstFailure = false
    }
    // 断言全过但回合带 errorKind：失败发生在断言之外（例如回合级系统错误）。
    if (turn.errorKind && firstFailure) {
      lines.push(`T${turn.index} ${turn.description} → 回合错误：${turn.errorKind}`)
    }
  }
  if (result.error) {
    lines.push(`场景错误${result.errorKind ? `（${result.errorKind}）` : ""}：${result.error}`)
  }
  if (lines.length === 0) lines.push("没有可展示的断言差异（场景未产生失败断言）")
  if (lines.length > MAX_FAILURE_LINES) {
    return [...lines.slice(0, MAX_FAILURE_LINES), `…… 还有 ${lines.length - MAX_FAILURE_LINES} 行（完整内容见报告）`]
  }
  return lines
}

/** 运行期 trace 事件的结构子集（`RuntimeTraceEvent` 的兼容面）。 */
export interface TraceLikeEvent {
  kind: string
  createdAt: number
  payload?: Record<string, unknown>
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0")
}

function stringifyPayload(payload: Record<string, unknown> | undefined): string {
  if (!payload || Object.keys(payload).length === 0) return ""
  let text: string
  try {
    text = JSON.stringify(payload)
  } catch {
    // payload 里出现循环引用时 JSON.stringify 会抛。这里不是静默：降级结果会直接
    // 印在那行事件里，读的人看到的就是「这行没带上 payload」。
    text = "[payload 无法序列化]"
  }
  if (text === undefined) return ""
  return text.length > MAX_EVENT_PAYLOAD ? `${text.slice(0, MAX_EVENT_PAYLOAD)}…` : text
}

/**
 * 失败窗口的事件序列：本场景保留的最后 `TRACE_WINDOW_SIZE` 条运行期事件。
 *
 * `seenCount` 是本场景事件总数；它大于 `events.length` 时头部写明截断，
 * 免得「最近 40 条」被读成「这场只发生了 40 件事」。
 */
export function formatTraceEvents(events: readonly TraceLikeEvent[], seenCount = events.length): string[] {
  if (events.length === 0) return ["事件序列：本场景没有运行期事件"]
  const header = seenCount > events.length
    ? `事件序列：最近 ${events.length} 条（本场景共 ${seenCount} 条）`
    : `事件序列：${events.length} 条`
  const lines = events.map(event => {
    const at = new Date(event.createdAt)
    const stamp = `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}`
    const payload = stringifyPayload(event.payload)
    return `${stamp} ${event.kind}${payload ? ` ${payload}` : ""}`
  })
  return [header, ...lines]
}

/** 耗时显示：毫秒 / 秒 / 分秒，避免窗口里出现 1234567ms 这种要心算的数字。 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

/** 顶部汇总条的文案：已跑 / 通过 / 失败 / 预期失败 / 剩余 / 耗时（跳过只在真有时才出现）。 */
export function renderSummary(summary: ProgressSummary): string {
  const parts = [
    `已跑 ${summary.done}/${summary.total}`,
    `通过 ${summary.passed}`,
    `失败 ${summary.failed}`,
    `预期失败 ${summary.expectedFailures}`,
    `剩余 ${summary.remaining}`,
    `耗时 ${formatDuration(summary.durationMs)}`,
  ]
  if (summary.skipped > 0) parts.push(`跳过 ${summary.skipped}`)
  return parts.join(" · ")
}

const STATUS_ICONS: Record<CaseStatus, string> = {
  pending: "·",
  running: "▸",
  pass: "✓",
  fail: "✗",
  "expected-failure": "!",
  skip: "–",
}

/** 状态图标：纯 ASCII/符号，不用 emoji（窗口字体不保证彩色字形）。 */
export function statusIcon(status: CaseStatus): string {
  return STATUS_ICONS[status]
}

export const STATUS_LABELS: Record<CaseStatus, string> = {
  pending: "待跑",
  running: "进行中",
  pass: "通过",
  "expected-failure": "预期失败",
  fail: "失败",
  skip: "跳过",
}

// ── DOM 视图（不可测，只写 DOM）──

export interface ProgressViewOptions {
  /** 报告（本次运行产物）的绝对路径。从运行开始就展示，结束再强调一次。 */
  reportPath?: string
  /** 「打开目录」的目标目录；缺省时按钮禁用。 */
  reportDir?: string
  /** 打开目录的动作。视图不碰 IPC，由宿主注入显式动作。 */
  openDirectory?: (dirPath: string) => void
}

export interface FinishOutcome {
  passed: boolean
  /** 结束行补充（数据集/契约失败、启动崩溃等场景用它说明为什么没跑场景）。 */
  note?: string
}

function span(className: string, text = ""): HTMLSpanElement {
  const element = document.createElement("span")
  element.className = className
  element.textContent = text
  return element
}

/**
 * 窗口实时进度视图。
 *
 * 行结构用 `<details>`：失败行建的时候就是 `open` —— 「失败立即展开」是契约要求，
 * 不是可选交互；通过的行等价于收起的一行摘要。
 */
export function createProgressView(root: HTMLElement, total: number, options: ProgressViewOptions = {}) {
  const model = createProgressModel(total)
  const rowElements = new Map<string, HTMLDetailsElement>()
  const bodyElements = new Map<string, HTMLElement>()

  const verdict = span("e2e-verdict", "运行中")
  const counts = span("e2e-counts", "")
  const reportPath = span("e2e-report-path", `报告：${options.reportPath ?? "未解析"}`)
  reportPath.title = options.reportPath ?? ""
  const openButton = document.createElement("button")
  openButton.type = "button"
  openButton.className = "e2e-open"
  openButton.textContent = "打开结果目录"
  openButton.title = "打开本次运行的数据目录（含 e2e-result.txt）；留存副本由启动器复制到报告目录，路径打印在终端"
  openButton.disabled = !(options.reportDir && options.openDirectory)
  openButton.addEventListener("click", () => {
    if (options.reportDir && options.openDirectory) options.openDirectory(options.reportDir)
  })

  const summaryBar = document.createElement("div")
  summaryBar.className = "e2e-summary"
  summaryBar.append(verdict, counts, reportPath, openButton)
  const caseList = document.createElement("div")
  caseList.className = "e2e-cases"
  const finishBar = document.createElement("div")
  finishBar.className = "e2e-finish"
  finishBar.hidden = true
  root.replaceChildren(summaryBar, caseList, finishBar)

  function syncSummary(): void {
    counts.textContent = renderSummary(model.summary())
  }
  // 先画一次：一个场景都没选中时，顶部也不能是一片空白。
  syncSummary()

  function syncRow(row: CaseRow): void {
    const element = rowElements.get(row.key)
    if (!element) return
    element.dataset.status = row.status
    const icon = element.querySelector(".e2e-icon")
    const elapsed = element.querySelector(".e2e-ms")
    if (icon) icon.textContent = statusIcon(row.status)
    // 耗时只在真的量过的地方写：待跑 / 进行中 / 跳过写 0ms 会被读成「跑完了」。
    const measured = row.status === "pass" || row.status === "fail" || row.status === "expected-failure"
    if (elapsed) elapsed.textContent = measured ? formatDuration(row.durationMs) : ""
    const body = bodyElements.get(row.key)
    if (body && row.detail) {
      body.replaceChildren(...row.detail.lines.map(line => {
        const item = document.createElement("div")
        item.className = "e2e-line"
        item.textContent = line
        return item
      }))
    }
    const label = STATUS_LABELS[row.status]
    element.title = `${row.caseId}${row.title ? ` · ${row.title}` : ""}（${label}）`
    // 失败行立即展开：契约要求「不看终端就能看见哪一条、期望什么、实际什么」。
    if (row.status === "fail") element.open = true
  }

  function ensureRow(key: string, caseId: string, title: string): void {
    if (rowElements.has(key)) return
    const element = document.createElement("details")
    element.className = "e2e-case"
    element.dataset.status = "pending"
    const head = document.createElement("summary")
    const sub = document.createElement("div")
    sub.className = "e2e-detail"
    head.append(
      span("e2e-icon", STATUS_ICONS.pending),
      span("e2e-id", caseId),
      span("e2e-ms"),
      span("e2e-title", title),
    )
    element.append(head, sub)
    element.addEventListener("toggle", () => {
      // 行里没有任何详情时不留下一个可以展开的空壳。
      if (element.open && sub.childElementCount === 0) element.open = false
    })
    rowElements.set(key, element)
    bodyElements.set(key, sub)
    caseList.append(element)
  }

  /**
   * 应用一个模型事件并同步 DOM。
   * 行先于事件建出来：事件引用的 key 还没登记过时，按「现在开始跑」把它补上，
   * 免得视图与模型各缺一行、对不上。
   */
  function apply(key: string, caseId: string, title: string, mutate: (model: ProgressModel) => void): void {
    ensureRow(key, caseId, title)
    mutate(model)
    const row = model.rows().find(candidate => candidate.key === key)
    if (row) syncRow(row)
    syncSummary()
  }

  return {
    plan(key: string, caseId: string, title: string): void {
      ensureRow(key, caseId, title)
      model.plan(key, caseId, title)
      syncSummary()
    },
    start(key: string, caseId: string, title: string): void {
      apply(key, caseId, title, model => model.start(key, title))
    },
    pass(key: string, ms: number): void {
      apply(key, key, "", model => model.pass(key, ms))
    },
    fail(key: string, ms: number, detail?: CaseDetailInput): void {
      apply(key, key, "", model => model.fail(key, ms, detail))
    },
    expectedFailure(key: string, ms: number): void {
      apply(key, key, "", model => model.expectedFailure(key, ms))
    },
    skip(key: string, reason?: string): void {
      apply(key, key, "", model => model.skip(key, reason))
    },
    finish(outcome: FinishOutcome): void {
      model.finish()
      verdict.textContent = outcome.passed ? "通过 (PASS)" : "失败 (FAIL)"
      verdict.dataset.verdict = outcome.passed ? "pass" : "fail"
      syncSummary()
      finishBar.hidden = false
      // 「打开报告目录」按钮留在顶部汇总条里（一直可见），这里只强调结束语与报告路径。
      finishBar.replaceChildren(
        span("e2e-finish-note", outcome.note ?? (outcome.passed ? "全部计划行已完成" : "见上方展开的失败行与报告")),
        span("e2e-finish-path", `报告（本次运行产物）：${options.reportPath ?? "路径未解析"}`),
      )
    },
  }
}

export type ProgressView = ReturnType<typeof createProgressView>
