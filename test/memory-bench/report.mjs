// ==========================================
// 外部记忆基准的报告呈现层：终端质量摘要 + 自包含 HTML 一页报告
//
// 只做「把已有 JSON 讲清楚」，不改采集与判分：
//   · summarizeBenchReport 是纯函数（L2 单测覆盖）；
//   · renderBenchHtmlReport 产出单文件 HTML（不引外部资源，双击即看）；
//   · CLI：node test/memory-bench/report.mjs <报告.json> [--no-html] [--print]
//
// 语义边界：外部集是观测性质量证据，质量指标（正确率/F1）不是门禁阈值；
// 报告必须同时给出「跑完状态」与「质量参考」，不得把两者混成一个 PASS。
// ==========================================

import { readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const PCT = 100

function rate(correct, judged) {
  return Number.isFinite(correct) && Number.isFinite(judged) && judged > 0 ? correct / judged : null
}

function pct(value, digits = 1) {
  return value === null || value === undefined ? "—" : `${(value * PCT).toFixed(digits)}%`
}

function num(value, digits = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US", { maximumFractionDigits: digits }) : "—"
}

function tokenSum(rows, key) {
  let total = 0
  let seen = 0
  for (const row of rows) {
    const value = row?.usage?.[key]
    if (typeof value === "number" && Number.isFinite(value)) { total += value; seen += 1 }
  }
  return { total, seen }
}

/** 报告文件可能带一行 PASS/FAIL 前缀；解析时从第一个 `{` 开始。 */
export function parseBenchReportPayload(text) {
  const index = text.indexOf("{")
  if (index < 0) throw new Error("报告文件里找不到 JSON 载荷")
  return JSON.parse(text.slice(index))
}

/**
 * 把 bench 报告压成可读摘要：质量（按数据集口径归一）、成本、灌库、检索、失败与逐题行。
 * 不判通过/不通过 —— 只回答「跑了多少、质量参考多少、花了多少」。
 */
export function summarizeBenchReport(report) {
  const scores = report?.scores ?? {}
  const outcomes = Array.isArray(report?.outcomes) ? report.outcomes : []
  const dataset = report?.dataset ?? "unknown"
  const failures = Array.isArray(report?.failures) ? report.failures : []
  const externalAdjudication = report?.externalAdjudication ?? null

  // 质量口径按数据集归一：LongMemEval 有 overall/分组，MemoryBank 是单一 accuracy，LoCoMo 是 F1。
  let quality = { kind: dataset, overall: null, buckets: [], breakdown: [], breakdownLabel: "分组" }
  if (dataset === "longmemeval") {
    const bucket = name => ({ name, ...(scores[name] ?? {}) })
    quality.overall = bucket("overall")
    const assistantBucket = { ...bucket("assistantOnly"),
      name: scores.assistantOnly?.includedInOverall === true ? "助手题型（计入总计）" : "助手题型（原报告未声明纳入总计）" }
    quality.buckets = [bucket("regular"), bucket("abstention"),
      assistantBucket,
      { ...(scores.productUserFactSubset ?? {}), name: "产品用户事实子集（范围见说明）", excludedFromTotal: true },
      { ...(scores.strictEmptyTool ?? {}), name: "严格空工具子集", excludedFromTotal: true }]
    quality.breakdown = (scores.byType ?? []).map(row => ({ name: row.questionType, ...row }))
    quality.breakdownLabel = "题型"
  } else if (dataset === "memorybank") {
    const accuracy = scores.accuracy ?? {}
    quality.overall = { cases: scores.cases ?? outcomes.length, judged: accuracy.judged, correct: accuracy.correct, accuracy: accuracy.value ?? null }
    quality.breakdownLabel = "检索"
  } else if (dataset === "locomo") {
    quality.overall = { cases: scores.cases ?? outcomes.length, judged: scores.scored, correct: null, accuracy: scores.meanScore ?? null, metric: "F1" }
    quality.breakdown = (scores.byCategory ?? []).map(row => ({ name: `category ${row.category}`, cases: row.count, judged: row.count, accuracy: row.meanScore }))
    quality.breakdownLabel = "类别（F1）"
  } else {
    quality.overall = { cases: outcomes.length, judged: null, correct: null, accuracy: null }
  }

  const agentUsage = {
    inputTokens: tokenSum(outcomes, "inputTokens").total,
    outputTokens: tokenSum(outcomes, "outputTokens").total,
    cacheReadTokens: tokenSum(outcomes, "cacheReadTokens").total,
    cacheWriteTokens: tokenSum(outcomes, "cacheWriteTokens").total,
    uncachedInputTokens: tokenSum(outcomes, "uncachedInputTokens").total,
    requests: tokenSum(outcomes, "requests").total,
  }
  const judgeUsage = { inputTokens: 0, outputTokens: 0, adjudicated: 0 }
  for (const outcome of outcomes) {
    const localJudgment = outcome?.localJudgment ?? outcome?.judgment
    const usage = localJudgment?.usage
    if (typeof usage?.inputTokens === "number") judgeUsage.inputTokens += usage.inputTokens
    if (typeof usage?.outputTokens === "number") judgeUsage.outputTokens += usage.outputTokens
    if (localJudgment?.adjudicated === true) judgeUsage.adjudicated += 1
  }
  const missingUsage = outcomes.filter(outcome => outcome?.status === "complete" && !outcome?.usage).length
  const started = Date.parse(report?.startedAt ?? "")
  const finished = Date.parse(report?.finishedAt ?? "")
  const durationMs = Number.isFinite(started) && Number.isFinite(finished) ? finished - started : null
  const firstText = outcomes.map(outcome => outcome?.metrics?.firstDeliveredTextDeltaMs).filter(value => typeof value === "number")

  const ingestTotals = { registeredSources: 0, processedSources: 0, oversizedSources: 0, sweeps: 0, scopeNormalized: 0 }
  const ingestSource = scores.ingest ?? null
  if (ingestSource) {
    for (const key of Object.keys(ingestTotals)) ingestTotals[key] = ingestSource[key] ?? 0
  } else {
    for (const outcome of outcomes) {
      const ingest = outcome?.ingest ?? {}
      for (const key of Object.keys(ingestTotals)) ingestTotals[key] += ingest[key] ?? 0
    }
  }

  const rows = outcomes.map(outcome => {
    const judgment = report?.externalAdjudication
      ? outcome?.externalJudgment ?? null
      : outcome?.externalJudgment ?? outcome?.judgment ?? null
    const correct = judgment?.adjudicated === true ? judgment.correct === true : null
    return {
      caseId: outcome?.caseId ?? "?",
      status: outcome?.status ?? "unknown",
      questionType: outcome?.caseRef?.questionType ?? outcome?.caseRef?.category ?? outcome?.caseRef?.persona ?? null,
      question: outcome?.caseRef?.question ?? null,
      answer: outcome?.answer ?? null,
      judged: judgment?.adjudicated === true,
      correct,
      raw: judgment?.raw ?? null,
      score: typeof outcome?.score === "number" ? outcome.score : null,
      inputTokens: outcome?.usage?.inputTokens ?? null,
      outputTokens: outcome?.usage?.outputTokens ?? null,
      firstTextMs: outcome?.metrics?.firstDeliveredTextDeltaMs ?? null,
      reuse: outcome?.groupReused === true,
    }
  })

  return {
    schemaVersion: report?.schemaVersion ?? null,
    dataset,
    split: report?.split ?? null,
    splitLabel: report?.splitLabel ?? `${dataset}/${report?.split ?? "?"}`,
    status: report?.status ?? "unknown",
    source: report?.source ?? null,
    model: report?.manifest?.model ?? null,
    provider: report?.manifest?.provider ?? null,
    judgeModel: externalAdjudication?.judge ?? report?.judgeModel ?? report?.judge?.model ?? null,
    seed: report?.seed ?? null,
    commit: report?.runEvidence?.commit ?? null,
    upstreamRevision: report?.upstream?.revision ?? null,
    plannedCells: report?.plannedCells ?? null,
    attemptedCells: report?.attemptedCells ?? null,
    completedCells: report?.completedCells ?? null,
    quality,
    agentUsage,
    judgeUsage,
    missingUsage,
    durationMs,
    firstTextMeanMs: firstText.length ? firstText.reduce((sum, value) => sum + value, 0) / firstText.length : null,
    firstTextSamples: firstText.length,
    ingest: ingestTotals,
    retrieval: scores.retrieval ?? null,
    externalAdjudication,
    failures: failures.map(failure => ({ caseId: failure?.caseId ?? null, kind: failure?.kind ?? "unknown", message: failure?.message ?? "" })),
    rows,
  }
}

/** 终端质量摘要：先给「跑完状态」，再给「质量参考」，最后给成本与文件路径。 */
export function formatBenchSummary(summary, options = {}) {
  const lines = []
  const head = `记忆基准 · ${summary.splitLabel}${summary.judgeModel ? `   judge: ${summary.judgeModel}` : ""}`
  lines.push(head)
  lines.push(`跑完 ${summary.completedCells ?? "?"}/${summary.plannedCells ?? "?"} · 失败 ${summary.failures.length} · 状态 ${summary.status}`)
  const overall = summary.quality?.overall
  const metric = summary.quality?.kind === "locomo" ? "平均 F1" : "正确率"
  if (overall && overall.accuracy !== null && overall.accuracy !== undefined) {
    const detail = summary.quality?.kind === "locomo"
      ? `n=${overall.judged ?? "?"}`
      : `${overall.correct ?? "?"}/${overall.judged ?? "?"}`
    lines.push(`质量参考（观测指标，非门禁阈值）：${metric} ${pct(overall.accuracy)}（${detail}）`)
    const buckets = (summary.quality.buckets ?? []).filter(bucket => bucket && bucket.judged > 0)
    if (buckets.length) lines.push(`  ${buckets.map(bucket => `${bucket.name} ${pct(bucket.accuracy)}`).join(" · ")}`)
  } else {
    lines.push("质量参考：无已判分样本（judge 关闭或全部未裁决）")
  }
  const breakdown = (summary.quality.breakdown ?? []).filter(row => row.judged > 0 || row.cases > 0)
  if (breakdown.length) {
    lines.push(`  ${summary.quality.breakdownLabel}：` + breakdown.slice(0, 8)
      .map(row => `${row.name} ${row.accuracy === null || row.accuracy === undefined ? "—" : pct(row.accuracy)}`).join(" · "))
  }
  if (summary.quality.kind === "longmemeval") {
    for (const bucket of summary.quality.buckets ?? [])
      if (bucket.note) lines.push(`  ${bucket.name}口径：${bucket.note}`)
  }
  const usage = summary.agentUsage
  const localJudgeLabel = summary.externalAdjudication ? "本地 judge" : "judge"
  lines.push(`成本：输入 ${num(usage.inputTokens)}（未缓存 ${num(usage.uncachedInputTokens)}）· 输出 ${num(usage.outputTokens)}`
    + ` · 缓存读 ${num(usage.cacheReadTokens)}${usage.cacheWriteTokens ? ` / 写 ${num(usage.cacheWriteTokens)}` : ""}`
    + ` · 请求 ${num(usage.requests)}${summary.judgeUsage.adjudicated ? ` · ${localJudgeLabel} ${summary.judgeUsage.adjudicated} 次（入 ${num(summary.judgeUsage.inputTokens)} / 出 ${num(summary.judgeUsage.outputTokens)}）` : ""}`
    + (summary.missingUsage ? ` · 缺 usage ${summary.missingUsage} 条` : ""))
  const ingest = summary.ingest
  lines.push(`灌库：登记 ${num(ingest.registeredSources)} · 处理 ${num(ingest.processedSources)} · sweeps ${num(ingest.sweeps)}`
    + (ingest.oversizedSources ? ` · oversized ${num(ingest.oversizedSources)}` : "")
    + (ingest.scopeNormalized ? ` · scope 归一 ${num(ingest.scopeNormalized)}` : ""))
  if (summary.durationMs !== null) lines.push(`用时 ${(summary.durationMs / 60000).toFixed(1)} 分钟`
    + (summary.firstTextMeanMs !== null ? ` · 首文本均值 ${num(summary.firstTextMeanMs)}ms（n=${summary.firstTextSamples}）` : ""))
  if (summary.failures.length) {
    lines.push("失败：")
    for (const failure of summary.failures.slice(0, 8))
      lines.push(`  - ${failure.caseId ?? "(run)"} [${failure.kind}] ${String(failure.message).slice(0, 120)}`)
  }
  if (options.reportPath) lines.push(`报告：${options.reportPath}`)
  if (options.htmlPath) lines.push(`HTML：${options.htmlPath}`)
  if (options.hypothesesPath) lines.push(`逐题 hypotheses：${options.hypothesesPath}`)
  const adjudication = summary.externalAdjudication
  if (adjudication) {
    const coverage = adjudication.coverage ?? {}
    lines.push(`外部逐题判分：${adjudication.judge} · ${adjudication.method} · scope ${adjudication.scope}`)
    lines.push(`判分时间 ${adjudication.judgedAt} · coverage ${coverage.verdictsAccepted ?? 0}/${coverage.selectedCases ?? "?"}`
      + `（未导出回答 ${coverage.missingHypotheses ?? "?"} · 缺 verdict ${coverage.missingVerdicts ?? "?"}）`)
    if (coverage.unknownCaseTypeCount || coverage.unknownAbstentionCount)
      lines.push(`旧报告题级映射未知：题型 ${coverage.unknownCaseTypeCount ?? 0} 道 · abstention ${coverage.unknownAbstentionCount ?? 0} 道；题型 cases 仅沿用报告 aggregate 计数`)
    if (adjudication.hypothesesFile || adjudication.verdictLogFile)
      lines.push(`判分文件：hypotheses ${adjudication.hypothesesFile ?? "—"} · verdict log ${adjudication.verdictLogFile ?? "—"}`)
  }
  return lines.join("\n")
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]))
}

function qualityCards(summary) {
  const cards = []
  const overall = summary.quality?.overall
  if (overall) {
    const metric = summary.quality.kind === "locomo" ? "平均 F1" : "正确率"
    cards.push({ label: `总体${metric}`, value: overall.accuracy === null || overall.accuracy === undefined ? "—" : pct(overall.accuracy),
      detail: summary.quality.kind === "locomo" ? `n=${overall.judged ?? "?"}` : `${overall.correct ?? "?"}/${overall.judged ?? "?"} 正确` })
  }
  for (const bucket of summary.quality?.buckets ?? []) {
    if (!bucket || bucket.judged === undefined) continue
    const detail = bucket.eligible !== undefined
      ? `${bucket.correct ?? 0}/${bucket.judged ?? 0} · 严格样本 ${bucket.eligible} · 污染 ${bucket.contaminated ?? 0} · 未知 ${bucket.unknown ?? 0} · 未完成 ${bucket.notCompleted ?? bucket.incomplete ?? 0}`
      : `${bucket.correct ?? "?"}/${bucket.judged ?? "?"}`
    cards.push({ label: bucket.name + (bucket.excludedFromTotal && !String(bucket.name).includes("不计") ? "（不计总计）" : ""),
      value: bucket.accuracy === null || bucket.accuracy === undefined ? "—" : pct(bucket.accuracy),
      detail, note: bucket.note ?? null })
  }
  return cards
}

/** 自包含 HTML 一页报告：质量卡 + 分组表 + 成本/灌库/检索 + 逐题表。 */
export function renderBenchHtmlReport(report, options = {}) {
  const summary = summarizeBenchReport(report)
  const cards = qualityCards(summary)
  const breakdown = summary.quality?.breakdown ?? []
  const rowHtml = summary.rows.map(row => {
    const verdict = row.score !== null ? row.score.toFixed(3)
      : row.correct === true ? "✓" : row.correct === false ? "✗" : row.judged ? "?" : "—"
    return `<details class="case" data-verdict="${row.correct === true ? "ok" : row.correct === false ? "bad" : "unknown"}">
      <summary>
        <span class="verdict">${verdict}</span>
        <span class="case-id">${escapeHtml(row.caseId)}</span>
        <span class="type">${escapeHtml(row.questionType ?? "")}</span>
        <span class="tokens">${row.inputTokens === null ? "—" : num(row.inputTokens)}→${row.outputTokens === null ? "—" : num(row.outputTokens)}</span>
        <span class="ms">${row.firstTextMs === null ? "" : `${num(row.firstTextMs)}ms`}</span>
        <span class="question">${escapeHtml(String(row.question ?? "").slice(0, 80))}</span>
      </summary>
      <div class="case-body">
        <div class="q">${escapeHtml(row.question ?? "（报告未携带题面）")}</div>
        <div class="a">${escapeHtml(row.answer ?? "（无回答）")}</div>
        <div class="meta">status=${escapeHtml(row.status)} · judged=${row.judged ? "yes" : "no"} · raw=${escapeHtml(row.raw ?? "—")} · reuse=${row.reuse ? "yes" : "no"}</div>
      </div>
    </details>`
  }).join("\n")

  const failureHtml = summary.failures.length
    ? `<section><h2>失败（${summary.failures.length}）</h2><ul>${summary.failures.map(failure =>
      `<li><b>${escapeHtml(failure.caseId ?? "(run)")}</b> [${escapeHtml(failure.kind)}] ${escapeHtml(failure.message)}</li>`).join("")}</ul></section>`
    : ""
  const adjudication = summary.externalAdjudication
  const adjudicationHtml = adjudication
    ? `<section><h2>外部逐题判分与覆盖</h2><div class="meta-grid"><span>判分者：${escapeHtml(adjudication.judge)}</span><span>口径：${escapeHtml(adjudication.method)}</span><span>scope：${escapeHtml(adjudication.scope)}</span><span>判分时间：${escapeHtml(adjudication.judgedAt)}</span><span>导入时间：${escapeHtml(adjudication.importedAt)}</span><span>原始报告 SHA-256：${escapeHtml(adjudication.sourceReportSha256)}</span><span>hypotheses：${escapeHtml(adjudication.hypothesesFile ?? "未记录")}</span><span>hypotheses SHA-256：${escapeHtml(adjudication.hypothesesFileSha256 ?? "未记录")}</span><span>判分日志：${escapeHtml(adjudication.verdictLogFile ?? "未记录")}</span><span>判分日志 SHA-256：${escapeHtml(adjudication.verdictLogSha256)}</span><span>覆盖：${adjudication.coverage?.verdictsAccepted ?? 0}/${adjudication.coverage?.selectedCases ?? "?"}；未导出回答 ${adjudication.coverage?.missingHypotheses ?? "?"}；缺 verdict ${adjudication.coverage?.missingVerdicts ?? "?"}</span><span>题型映射：${escapeHtml(adjudication.coverage?.caseTypeMapping ?? "未记录")}；题型未知 ${adjudication.coverage?.unknownCaseTypeCount ?? 0}；abstention 未知 ${adjudication.coverage?.unknownAbstentionCount ?? 0}</span></div><p class="note">${escapeHtml(adjudication.note ?? "")}</p></section>`
    : ""
  const breakdownHtml = breakdown.length
    ? `<section><h2>${escapeHtml(summary.quality.breakdownLabel)}</h2><table><thead><tr><th>名称</th><th>样本</th><th>判分</th><th>${summary.quality.kind === "locomo" ? "F1" : "正确率"}</th></tr></thead><tbody>${
      breakdown.map(row => `<tr><td>${escapeHtml(row.name)}</td><td>${row.cases ?? "—"}</td><td>${row.judged ?? "—"}</td><td>${row.accuracy === null || row.accuracy === undefined ? "—" : pct(row.accuracy)}</td></tr>`).join("")
    }</tbody></table></section>`
    : ""
  const retrieval = summary.retrieval
  const retrievalHtml = retrieval
    ? `<section><h2>检索（本仓适配口径）</h2><table><tbody>${
      Object.entries(retrieval).filter(([, value]) => typeof value === "number")
        .map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${num(value, 3)}</td></tr>`).join("")
    }</tbody></table>${retrieval.note ? `<p class="note">${escapeHtml(retrieval.note)}</p>` : ""}</section>`
    : ""

  return `<!doctype html>
<html lang="zh"><head><meta charset="UTF-8" /><title>记忆基准 · ${escapeHtml(summary.splitLabel)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 28px 32px 48px; background: #f6f7f9; color: #1f242b;
    font: 14px/1.6 -apple-system, "PingFang SC", "Helvetica Neue", Arial, sans-serif; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 26px 0 10px; }
  .sub { color: #5c6570; margin-bottom: 18px; }
  .cards { display: flex; flex-wrap: wrap; gap: 12px; }
  .card { min-width: 170px; padding: 14px 16px; border: 1px solid #e2e6eb; border-radius: 10px; background: #fff; }
  .card .label { color: #5c6570; font-size: 12px; }
  .card .value { font-size: 26px; font-weight: 700; margin: 2px 0; }
  .card .detail { color: #79818c; font-size: 12px; }
  .meta-grid { display: flex; flex-wrap: wrap; gap: 8px 22px; padding: 12px 16px; border: 1px solid #e2e6eb;
    border-radius: 10px; background: #fff; color: #4a5560; font-size: 13px; }
  table { border-collapse: collapse; width: 100%; background: #fff; border: 1px solid #e2e6eb; border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #eef1f4; font-size: 13px; }
  th { background: #f0f2f5; color: #4a5560; font-weight: 600; }
  .case { background: #fff; border: 1px solid #e2e6eb; border-radius: 8px; margin: 6px 0; }
  .case > summary { display: flex; gap: 10px; align-items: center; padding: 8px 12px; cursor: pointer; list-style: none; }
  .case > summary::-webkit-details-marker { display: none; }
  .case .verdict { width: 1.6em; text-align: center; font-weight: 700; }
  .case[data-verdict="ok"] .verdict { color: #1a7f37; }
  .case[data-verdict="bad"] .verdict { color: #c62828; }
  .case .case-id { color: #4a5560; font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
  .case .type { color: #6b7480; font-size: 12px; }
  .case .tokens, .case .ms { color: #98a1ab; font-size: 12px; margin-left: auto; }
  .case .ms { margin-left: 0; }
  .case .question { color: #6b7480; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 45%; }
  .case-body { padding: 4px 14px 12px 40px; }
  .case-body .q { color: #4a5560; }
  .case-body .a { margin: 6px 0; white-space: pre-wrap; }
  .case-body .meta { color: #98a1ab; font-size: 12px; }
  .note { margin-top: 18px; color: #79818c; font-size: 12px; }
</style></head>
<body>
  <h1>记忆基准 · ${escapeHtml(summary.splitLabel)}</h1>
  <div class="sub">观测性质量证据（非门禁阈值）：跑完状态与质量参考分列，PASS 只表示完整跑完。</div>
  <div class="meta-grid">
    <span>状态：<b>${escapeHtml(summary.status)}</b></span>
    <span>跑完：<b>${summary.completedCells ?? "?"}/${summary.plannedCells ?? "?"}</b></span>
    <span>被测模型：${escapeHtml(summary.model ?? "—")}</span>
    <span>judge：${escapeHtml(summary.judgeModel ?? "关闭")}</span>
    <span>seed：${escapeHtml(summary.seed ?? "—")}</span>
    <span>commit：${escapeHtml(String(summary.commit ?? "—").slice(0, 12))}</span>
    <span>数据 revision：${escapeHtml(String(summary.upstreamRevision ?? "—").slice(0, 12))}</span>
    <span>用时：${summary.durationMs === null ? "—" : `${(summary.durationMs / 60000).toFixed(1)} 分钟`}</span>
  </div>
  <section><h2>质量参考</h2><div class="cards">${cards.map(card =>
    `<div class="card"><div class="label">${escapeHtml(card.label)}</div><div class="value">${escapeHtml(card.value)}</div><div class="detail">${escapeHtml(card.detail)}${card.note ? `<br />${escapeHtml(card.note)}` : ""}</div></div>`).join("")}</div></section>
  ${breakdownHtml}
  ${adjudicationHtml}
  <section><h2>成本</h2><table><tbody>
    <tr><td>输入（未缓存）</td><td>${num(summary.agentUsage.inputTokens)}（${num(summary.agentUsage.uncachedInputTokens)}）</td></tr>
    <tr><td>输出</td><td>${num(summary.agentUsage.outputTokens)}</td></tr>
    <tr><td>缓存读 / 写</td><td>${num(summary.agentUsage.cacheReadTokens)} / ${num(summary.agentUsage.cacheWriteTokens)}</td></tr>
    <tr><td>模型请求</td><td>${num(summary.agentUsage.requests)}${summary.missingUsage ? ` · 缺 usage ${summary.missingUsage} 条` : ""}</td></tr>
    ${summary.judgeUsage.adjudicated ? `<tr><td>${summary.externalAdjudication ? "本地 judge" : "judge"}（${summary.judgeUsage.adjudicated} 次）</td><td>入 ${num(summary.judgeUsage.inputTokens)} / 出 ${num(summary.judgeUsage.outputTokens)}</td></tr>` : ""}
    ${summary.firstTextMeanMs !== null ? `<tr><td>首文本均值</td><td>${num(summary.firstTextMeanMs)}ms（n=${summary.firstTextSamples}）</td></tr>` : ""}
  </tbody></table></section>
  <section><h2>灌库</h2><table><tbody>
    <tr><td>登记 / 处理来源</td><td>${num(summary.ingest.registeredSources)} / ${num(summary.ingest.processedSources)}</td></tr>
    <tr><td>sweeps / oversized</td><td>${num(summary.ingest.sweeps)} / ${num(summary.ingest.oversizedSources)}</td></tr>
    ${summary.ingest.scopeNormalized ? `<tr><td>scope 归一</td><td>${num(summary.ingest.scopeNormalized)}</td></tr>` : ""}
  </tbody></table></section>
  ${retrievalHtml}
  ${failureHtml}
  <section><h2>逐题（${summary.rows.length}）</h2>${rowHtml || "<div class='note'>没有逐题结果。</div>"}</section>
  <div class="note">
    报告 JSON：${escapeHtml(options.reportPath ?? "")}${options.hypothesesPath ? `<br />逐题 hypotheses（官方脚本可消费）：${escapeHtml(options.hypothesesPath)}` : ""}
  </div>
</body></html>
`
}

/** 读取一份报告文件：打印摘要、写同名 .html，返回两份产物路径与摘要。 */
export function writeBenchReport(reportPath, options = {}) {
  const report = parseBenchReportPayload(readFileSync(reportPath, "utf8"))
  const summary = summarizeBenchReport(report)
  const htmlPath = join(dirname(reportPath), `${basename(reportPath).replace(/\.json$/i, "")}.html`)
  const text = formatBenchSummary(summary, { reportPath, htmlPath, ...(options.hypothesesPath ? { hypothesesPath: options.hypothesesPath } : {}) })
  if (options.writeHtml !== false) writeFileSync(htmlPath, renderBenchHtmlReport(report, { reportPath, ...(options.hypothesesPath ? { hypothesesPath: options.hypothesesPath } : {}) }))
  return { reportPath, htmlPath, summary, text, report }
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  const args = process.argv.slice(2)
  const reportPath = args.find(arg => !arg.startsWith("--"))
  if (!reportPath) {
    console.error("用法: node test/memory-bench/report.mjs <报告.json> [--no-html] [--print]")
    process.exit(2)
  }
  try {
    const result = writeBenchReport(reportPath, { writeHtml: !args.includes("--no-html") })
    console.log(result.text)
  } catch (error) {
    console.error(`报告渲染失败: ${error?.message ?? error}`)
    process.exit(1)
  }
}
