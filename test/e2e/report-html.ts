// ==========================================
// HTML 报告：单文件、内联 CSS/JS、零外部资源
// ==========================================
//
// 为什么是纯函数：报告在 Tauri 窗口里生成（`reporter.ts` 的 `formatReport()` 被
// `e2e-main.ts` 调用），又要在 Node 单测里断言产物文本。所以这里只拼字符串：
// 不碰 DOM、不读环境、不 import 任何 UI 依赖 —— 契约选型时已否决
// `@vitest-evals/report-ui`（会拖进 React 19 + Vite 7）。
//
// 「自包含」是硬约束，产物里不允许出现任何外部资源引用：没有 <script src>、
// 没有 <link ... href>、没有 http(s) 字面量（见 escapeText）。页面**静态渲染** ——
// 标识、结果与断言差异都直接写进 HTML 文本，内联脚本只负责筛选与展开/收起。
// 于是「双击即看」与「rg 文件本身就能对账」都不依赖脚本能否执行。
//
// 顶部必须直出四个可核对标识（runId / commit / dataset 版本 / cases 与 trials 计数）：
// 报告文件会被保留策略淘汰，归档文档只引用这些标识，不引用文件名 ——
// 标识必须能从文件本身读到，而不是只活在某个数据块里等脚本渲染。

import type { AssertionResult, SceneResult, TestReport, TurnResult } from "./types"
// 契约结果类型由宿主侧定义，`e2e/types.ts` 只消费不转出 —— 报告渲染器要画它，
// 就从它的定义处 import（与 types.ts 自己取这几个类型同一条路径）。
import type { ContractCheckResult } from "../host/types"

// ── 顶部可核对标识 ──

/** 归档对账只认这几个字段；键名就是页面上的 `data-ident` 值。 */
type IdentKey = "runId" | "commit" | "dataset" | "cases" | "trials"

// ── 转义 ──

/**
 * 文本 → HTML 文本节点。
 *
 * 比常规转义多做一步：把 `://` 写成 `:&#47;&#47;`。页面上的渲染结果完全相同，
 * 但产物文本里不会出现 `https://` 字面量 —— 「零外部资源」因此可以对整个文件直接
 * `rg 'https?://'` 判定，不必先分辨某一处 URL 是引用还是数据（错误文案与工具结果
 * 里带 URL 是常态，报告不该因为它们而被判成「有外部资源」）。
 */
function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/:\/\//g, ":&#47;&#47;")
}

const STATUS_TEXT: Record<SceneResult["status"], string> = {
  pass: "通过",
  fail: "失败",
  timeout: "超时",
  skip: "跳过",
}

const STATUS_GLYPH: Record<SceneResult["status"], string> = {
  pass: "✓",
  fail: "✕",
  timeout: "⏱",
  skip: "⊘",
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

// ── 片段 ──

function identItem(key: IdentKey, value: string, note?: string): string {
  return [
    '        <div class="ident-item">',
    `          <span class="ident-key">${key}</span>`,
    `          <code class="ident-value" data-ident="${key}">${escapeText(value)}</code>`,
    note ? `          <span class="ident-note">${escapeText(note)}</span>` : "",
    "        </div>",
  ].filter(line => line !== "").join("\n")
}

/**
 * 顶部标识块。四个必需标识之外的字段（timestamp / schemaVersion / platform / seedHash /
 * filters）是给排查用的上下文，不是对账凭据。
 */
function identBlock(report: TestReport): string {
  const summary = report.summary
  const items = [
    identItem("runId", report.runId),
    identItem("commit", report.environment.commit || "未记录"),
    identItem("dataset", report.datasetVersion, report.environment.seedHash ? `seed ${report.environment.seedHash}` : undefined),
    identItem("cases", String(summary.totalCases), `已执行 ${summary.executedCases}`),
    identItem(
      "trials",
      String(summary.totalTrials),
      `计划 ${summary.plannedTrials} · 执行 ${summary.executedTrials} · 跳过 ${summary.skipped}`,
    ),
  ]

  return [
    '      <dl class="ident">',
    ...items,
    "      </dl>",
  ].join("\n")
}

function kpi(label: string, value: string, status?: SceneResult["status"]): string {
  const mark = status ? `<span class="mark ${statusClass(status)}"></span>` : ""
  return [
    '        <div class="kpi">',
    `          <span class="kpi-value">${escapeText(value)}</span>`,
    `          <span class="kpi-label">${mark}${escapeText(label)}</span>`,
    "        </div>",
  ].join("\n")
}

function statusClass(status: SceneResult["status"]): string {
  return `s-${status}`
}

function kpiRow(report: TestReport, expectedFailureTurns: number): string {
  const summary = report.summary
  return [
    '      <section class="kpis">',
    kpi("通过", String(summary.passed), "pass"),
    kpi("失败", String(summary.failed), "fail"),
    kpi("超时", String(summary.timeout), "timeout"),
    kpi("跳过", String(summary.skipped), "skip"),
    kpi("预期失败回合", String(expectedFailureTurns)),
    kpi("通过率", percent(summary.passRate)),
    kpi("pass@k", percent(summary.passAtK)),
    kpi("pass^k", percent(summary.passPowerK)),
    kpi("耗时", seconds(summary.totalDuration)),
    "      </section>",
  ].join("\n")
}

function filterLine(options: TestReport["options"]): string {
  const parts = [
    options.module ? `module=${options.module}` : "",
    options.scene ? `scene=${options.scene}` : "",
    options.caseId ? `case=${options.caseId}` : "",
    options.tag ? `tag=${options.tag}` : "",
    options.suite ? `suite=${options.suite}` : "",
    `repeat=${options.repeat}`,
    `strictContracts=${options.strictContracts}`,
    `report=${options.report}`,
  ].filter(part => part !== "")
  return `筛选：${escapeText(parts.join(" · "))}`
}

function assertionItem(assertion: AssertionResult): string {
  const detail: string[] = []
  if (assertion.expected !== undefined) detail.push(`          <dt>期望</dt><dd><code>${escapeText(assertion.expected)}</code></dd>`)
  if (assertion.actual !== undefined) detail.push(`          <dt>实际</dt><dd><code>${escapeText(assertion.actual)}</code></dd>`)
  if (assertion.error !== undefined) detail.push(`          <dt>错误</dt><dd><code>${escapeText(assertion.error)}</code></dd>`)

  return [
    `        <li class="check ${assertion.pass ? "check-pass" : "check-fail"}">`,
    `          <span class="check-type">${assertion.pass ? "✓" : "✕"} ${escapeText(assertion.type)}</span>`,
    detail.length > 0 ? ['          <dl class="diff">', ...detail, "          </dl>"].join("\n") : "",
    "        </li>",
  ].filter(line => line !== "").join("\n")
}

function turnBlock(turn: TurnResult): string {
  const passed = turn.assertions.filter(assertion => assertion.pass).length
  // 预期失败是场景声明的一部分：通过的场景里也必须能看出这个回合是按声明失败的。
  const expected = turn.expectedFailure
    ? `<span class="badge">预期失败 ${escapeText(turn.expectedFailure.kind)}</span>`
    : ""
  const errorKind = turn.errorKind ? `<span class="badge">${escapeText(turn.errorKind)}</span>` : ""

  return [
    '      <div class="turn">',
    '        <div class="turn-head">',
    `          <span class="turn-title">T${turn.index} ${escapeText(turn.description)}</span>`,
    expected,
    errorKind,
    `          <span class="turn-stats">${passed}/${turn.assertions.length} 断言 · ${turn.metrics.replyChars} 字符 · ${turn.metrics.toolCalls} 工具 · ${turn.metrics.retries} 重试 · ${seconds(turn.metrics.duration)}</span>`,
    "        </div>",
    `        <p class="turn-input">用户输入：${escapeText(turn.userText)}</p>`,
    '        <ul class="checks">',
    ...turn.assertions.map(assertionItem),
    "        </ul>",
    "      </div>",
  ].join("\n")
}

/**
 * 一个 case（一次 trial）一行。
 *
 * `open` 的判据是 `status !== "pass"`：失败、超时、跳过都默认展开。跳过如果默认收起，
 * 一份「看起来全绿」的报告会把「这条根本没跑」藏起来 —— 而这不比失败轻。
 */
function caseBlock(scene: SceneResult): string {
  const open = scene.status === "pass" ? "" : " open"
  const body = [
    ...scene.turns.map(turnBlock),
    scene.error ? `      <p class="scene-error">${escapeText(scene.errorKind ?? "unknown")}: ${escapeText(scene.error)}</p>` : "",
  ].filter(line => line !== "").join("\n")

  return [
    `      <details class="case" data-status="${scene.status}"${open}>`,
    '        <summary class="case-sum">',
    `          <span class="pill ${statusClass(scene.status)}"><span class="mark"></span>${STATUS_GLYPH[scene.status]} ${STATUS_TEXT[scene.status]}</span>`,
    `          <code class="case-id">${escapeText(scene.caseId)}</code>`,
    `          <span class="case-meta">#${scene.trial} · ${escapeText(scene.scene)} · ${escapeText(scene.module)} · ${escapeText(scene.contractId)} · ${escapeText(scene.suite)} · ${escapeText(scene.entry)} · ${seconds(scene.duration)}</span>`,
    "        </summary>",
    '        <div class="case-body">',
    body,
    "        </div>",
    "      </details>",
  ].join("\n")
}

function contractBlock(contracts: ContractCheckResult[]): string {
  const lines: string[] = []
  for (const contract of contracts) {
    if (contract.stale) {
      lines.push(`        <li class="alert alert-critical"><strong>${escapeText(contract.module)}</strong> 契约过期：${escapeText(contract.staleReason ?? "sourceHash 未确认")}</li>`)
    }
    const detail = [...contract.missing, ...contract.gaps].join("; ")
    if (!contract.valid && detail) {
      lines.push(`        <li class="alert alert-serious"><strong>${escapeText(contract.module)}</strong> 覆盖缺口：${escapeText(detail)}</li>`)
    }
  }
  if (lines.length === 0) return ""
  return ['    <section class="alerts">', '      <h2 class="section-title">契约</h2>', "      <ul>", ...lines, "      </ul>", "    </section>"].join("\n")
}

function datasetErrorBlock(errors: string[]): string {
  if (errors.length === 0) return ""
  return [
    '    <section class="alerts">',
    '      <h2 class="section-title">Dataset 错误</h2>',
    "      <ul>",
    ...errors.map(error => `        <li class="alert alert-critical">${escapeText(error)}</li>`),
    "      </ul>",
    "    </section>",
  ].join("\n")
}

// ── 页面 ──

export function renderHtmlReport(report: TestReport): string {
  const summary = report.summary
  const expectedFailureTurns = report.scenes.reduce(
    (sum, scene) => sum + scene.turns.filter(turn => turn.expectedFailure).length,
    0,
  )
  const failedCases = report.scenes.filter(scene => scene.status !== "pass").length

  const caseList = report.scenes.length > 0
    ? report.scenes.map(caseBlock).join("\n")
    : '      <p class="empty">本次没有执行任何场景（报告可能在数据集或契约门禁处提前结束）。</p>'

  return [
    "<!DOCTYPE html>",
    '<html lang="zh-CN">',
    "  <head>",
    '    <meta charset="utf-8">',
    '    <meta name="viewport" content="width=device-width, initial-scale=1">',
    '    <meta name="color-scheme" content="light dark">',
    `    <title>Desk-Pet Live Test 报告 ${escapeText(report.runId)}</title>`,
    `    <style>${STYLE}</style>`,
    "  </head>",
    "  <body>",
    '    <main class="page">',
    '      <header class="head">',
    '        <div class="head-title">',
    "          <h1>Desk-Pet Live Test 报告</h1>",
    `          <p class="sub">${escapeText(report.schemaVersion)} · ${escapeText(report.timestamp)} · ${escapeText(report.environment.platform ?? "未知平台")}</p>`,
    "        </div>",
    `        <p class="hint">归档引用请写下面这些标识，不要写报告文件名 —— 报告会被保留策略淘汰。</p>`,
    identBlock(report),
    "      </header>",
    kpiRow(report, expectedFailureTurns),
    '      <section class="meta">',
    `        <p>${filterLine(report.options)}</p>`,
    `        <p>环境：${escapeText(report.environment.userAgent ?? "未知")}</p>`,
    `        <p>汇总：${summary.total} 次 trial · 数据集错误 ${report.datasetErrors.length} 条 · 契约 ${report.contracts.length} 份</p>`,
    "      </section>",
    datasetErrorBlock(report.datasetErrors),
    contractBlock(report.contracts),
    '      <section class="cases">',
    '        <div class="cases-head">',
    '          <h2 class="section-title">Cases</h2>',
    '          <div class="filters" role="group" aria-label="筛选">',
    `            <button type="button" data-filter="all" aria-pressed="true">全部（${report.scenes.length}）</button>`,
    `            <button type="button" data-filter="fail" aria-pressed="false">未通过（${failedCases}）</button>`,
    `            <button type="button" data-filter="pass" aria-pressed="false">通过（${report.scenes.length - failedCases}）</button>`,
    '            <span class="spacer"></span>',
    '            <button type="button" id="expand-all">全部展开</button>',
    '            <button type="button" id="collapse-all">全部收起</button>',
    "          </div>",
    "        </div>",
    caseList,
    "      </section>",
    `    <script>${SCRIPT}</script>`,
    "    </main>",
    "  </body>",
    "</html>",
    "",
  ].join("\n")
}

// ── 内联样式与脚本 ──
//
// 颜色取的是参考调性的「状态色 + 页面底色」：状态色是保留色，随图标/文字标签一起出现，
// 从不靠颜色单独表意；正文与数字一律用墨色，彩色只出现在小圆点与失败行的左侧边条上。
// 深浅色两套是各自选定的，不是把浅色翻转一下。

const STYLE = `
:root {
  color-scheme: light dark;
  --plane: #f9f9f7;
  --surface: #fcfcfb;
  --ink: #0b0b0b;
  --ink-2: #52514e;
  --ink-3: #898781;
  --line: #e1e0d9;
  --ring: rgba(11, 11, 11, 0.10);
  --good: #0ca30c;
  --warning: #fab219;
  --serious: #ec835a;
  --critical: #d03b3b;
}
@media (prefers-color-scheme: dark) {
  :root {
    --plane: #0d0d0d;
    --surface: #1a1a19;
    --ink: #ffffff;
    --ink-2: #c3c2b7;
    --ink-3: #898781;
    --line: #2c2c2a;
    --ring: rgba(255, 255, 255, 0.10);
  }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body {
  margin: 0;
  padding: 24px 16px 48px;
  background: var(--plane);
  color: var(--ink);
  font: 14px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
}
.page { max-width: 1100px; margin: 0 auto; display: grid; gap: 16px; }
h1 { font-size: 20px; margin: 0; }
h2 { font-size: 15px; margin: 0; }
.section-title { color: var(--ink-2); }
.head, .kpi, .case, .alerts, .meta {
  background: var(--surface);
  border: 1px solid var(--ring);
  border-radius: 10px;
}
.head { padding: 16px; }
.sub { margin: 4px 0 0; color: var(--ink-2); font-size: 12px; }
.hint { margin: 10px 0 0; color: var(--ink-3); font-size: 12px; }
.ident {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 10px 20px;
  margin: 14px 0 0;
  padding: 12px 0 0;
  border-top: 1px solid var(--line);
}
.ident-item { display: grid; gap: 1px; }
.ident-key { color: var(--ink-3); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
.ident-value { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; word-break: break-all; }
.ident-note { color: var(--ink-2); font-size: 11px; }
.kpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(112px, 1fr));
  gap: 10px;
}
.kpi { padding: 10px 12px; display: grid; gap: 2px; }
.kpi-value { font-size: 22px; font-weight: 600; }
.kpi-label { color: var(--ink-2); font-size: 12px; display: inline-flex; align-items: center; gap: 5px; }
.mark { width: 8px; height: 8px; border-radius: 50%; background: var(--ink-3); flex: none; }
.s-pass .mark { background: var(--good); }
.s-fail .mark { background: var(--critical); }
.s-timeout .mark { background: var(--serious); }
.s-skip .mark { background: var(--warning); }
.meta { padding: 10px 16px; color: var(--ink-2); font-size: 12px; }
.meta p { margin: 2px 0; word-break: break-word; }
.alerts { padding: 12px 16px; }
.alerts ul { margin: 8px 0 0; padding-left: 0; list-style: none; display: grid; gap: 6px; }
.alert { font-size: 13px; padding-left: 10px; border-left: 3px solid var(--ink-3); }
.alert-critical { border-left-color: var(--critical); }
.alert-serious { border-left-color: var(--serious); }
.cases { display: grid; gap: 8px; }
.cases-head { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; justify-content: space-between; margin-bottom: 8px; }
.filters { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.filters .spacer { width: 12px; }
button {
  font: inherit;
  font-size: 12px;
  color: var(--ink);
  background: var(--surface);
  border: 1px solid var(--ring);
  border-radius: 6px;
  padding: 4px 10px;
  cursor: pointer;
}
button:hover { border-color: var(--line); }
button[aria-pressed="true"] { border-color: var(--ink-3); font-weight: 600; }
.case { overflow: hidden; }
.case[data-status="fail"] { border-left: 3px solid var(--critical); }
.case[data-status="timeout"] { border-left: 3px solid var(--serious); }
.case[data-status="skip"] { border-left: 3px solid var(--warning); }
.case-sum {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  cursor: pointer;
}
.case-sum::marker { color: var(--ink-3); }
.pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  padding: 1px 8px;
  border: 1px solid var(--ring);
  border-radius: 999px;
  flex: none;
}
.case-id { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
.case-meta { color: var(--ink-2); font-size: 12px; font-variant-numeric: tabular-nums; }
.case-body { padding: 4px 14px 14px; border-top: 1px solid var(--line); }
.turn { padding: 10px 0; border-bottom: 1px dashed var(--line); }
.turn:last-child { border-bottom: none; }
.turn-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
.turn-title { font-weight: 600; }
.turn-stats { color: var(--ink-2); font-size: 12px; font-variant-numeric: tabular-nums; }
.badge {
  font-size: 11px;
  color: var(--ink-2);
  border: 1px solid var(--ring);
  border-radius: 999px;
  padding: 0 8px;
}
.turn-input { margin: 4px 0 6px; color: var(--ink-2); font-size: 12px; word-break: break-word; }
.checks { margin: 0; padding: 0; list-style: none; display: grid; gap: 6px; }
.check { padding: 4px 0 4px 10px; border-left: 3px solid var(--line); }
.check-pass { border-left-color: var(--good); }
.check-fail { border-left-color: var(--critical); }
.check-type { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.diff { margin: 4px 0 0; display: grid; grid-template-columns: max-content 1fr; gap: 2px 10px; }
.diff dt { color: var(--ink-3); font-size: 11px; }
.diff dd { margin: 0; }
.diff code {
  display: block;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--plane);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 4px 6px;
}
.scene-error { margin: 10px 0 0; padding-left: 10px; border-left: 3px solid var(--critical); font-size: 13px; word-break: break-word; }
.empty { color: var(--ink-2); }
`

/**
 * 渐进增强：筛选与展开/收起。
 *
 * 页面不依赖这段脚本 —— 默认视图（失败展开、通过收起、标识与断言差异全部直出）
 * 在脚本不执行时也完整可见。脚本只做「同一份内容的另一种看法」。
 */
const SCRIPT = `
(function () {
  var cases = Array.prototype.slice.call(document.querySelectorAll("details.case"));
  var buttons = Array.prototype.slice.call(document.querySelectorAll("[data-filter]"));

  function applyFilter(name) {
    cases.forEach(function (el) {
      var status = el.getAttribute("data-status");
      var visible = name === "all" || (name === "pass") === (status === "pass");
      el.hidden = !visible;
    });
    buttons.forEach(function (button) {
      button.setAttribute("aria-pressed", button.getAttribute("data-filter") === name ? "true" : "false");
    });
  }

  buttons.forEach(function (button) {
    button.addEventListener("click", function () { applyFilter(button.getAttribute("data-filter")); });
  });

  var expand = document.getElementById("expand-all");
  if (expand) expand.addEventListener("click", function () {
    cases.forEach(function (el) { el.open = true; });
  });

  var collapse = document.getElementById("collapse-all");
  if (collapse) collapse.addEventListener("click", function () {
    cases.forEach(function (el) { el.open = false; });
  });
})();
`
