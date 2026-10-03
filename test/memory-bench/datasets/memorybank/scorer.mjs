// ==========================================
// MemoryBank cn 计分器（纯函数）
// ==========================================
//
// 上游没有官方判分脚本，也没有金标答案（探测题只给问题）。分两层报告：
//   1. 确定性检索指标（不依赖 judge）：
//      · evidencePresentRate：至少渲染出一条记忆的题占比；
//      · dateHintHitRate：题面点名的日期（「5月2日」「4月27号」）在渲染证据的观测时间中出现的比例；
//      · renderedEvidenceP50：单题渲染证据条数中位数。
//   2. 正确率：由仓内 judge 对「问题 + 角色历史 + 模型回答」判 yes/no（本仓自适配口径，非官方指标）。

/** 从题面提取「N月N日/号」线索；跨年不敏感，只按 month/day 比对。 */
export function extractDateHints(question) {
  const hints = []
  const re = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g
  let match
  while ((match = re.exec(String(question ?? ""))) !== null) {
    const month = Number(match[1])
    const day = Number(match[2])
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) hints.push({ month, day })
  }
  return hints
}

function dateMatchesHint(observedAt, hint) {
  if (!Number.isFinite(observedAt)) return false
  const date = new Date(observedAt)
  return date.getUTCMonth() + 1 === hint.month && date.getUTCDate() === hint.day
}

function mean(values) {
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function percentile(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]
}

export function scoreMemoryBank(cases, outcomes, judgments = {}) {
  const byId = new Map(cases.map(item => [item.caseId, item]))
  const rows = []
  let withEvidence = 0
  let dateHintCases = 0
  let dateHintHits = 0
  let judged = 0
  let correct = 0
  let judgeFailures = 0
  const renderedCounts = []
  const ingest = { registeredSources: 0, processedSources: 0, oversizedSources: 0, sweeps: 0 }
  const byPersona = new Map()
  for (const outcome of outcomes) {
    const item = byId.get(outcome.caseId)
    if (!item) continue
    const evidence = Array.isArray(outcome.evidence) ? outcome.evidence : []
    if (evidence.length > 0) withEvidence += 1
    renderedCounts.push(evidence.length)
    const judgment = judgments[outcome.caseId]
    const rowJudged = judgment?.adjudicated === true
    if (judgment && judgment.adjudicated === false && judgment.error) judgeFailures += 1
    if (rowJudged) { judged += 1; if (judgment.correct === true) correct += 1 }
    const persona = byPersona.get(item.persona) ?? { persona: item.persona, cases: 0, judged: 0, correct: 0 }
    persona.cases += 1
    if (rowJudged) { persona.judged += 1; persona.correct += judgment.correct === true ? 1 : 0 }
    byPersona.set(item.persona, persona)
    const hints = extractDateHints(item.question)
    let dateHit = null
    if (hints.length > 0) {
      dateHintCases += 1
      dateHit = evidence.some(ref => hints.some(hint => dateMatchesHint(ref.observedAt, hint)))
      if (dateHit) dateHintHits += 1
    }
    const stats = outcome.ingest ?? {}
    ingest.registeredSources += stats.registeredSources ?? 0
    ingest.processedSources += stats.processedSources ?? 0
    ingest.oversizedSources += stats.oversizedSources ?? 0
    ingest.sweeps += stats.sweeps ?? 0
    rows.push({ caseId: item.caseId, persona: item.persona, status: outcome.status,
      judged: rowJudged, correct: rowJudged ? judgment.correct === true : null,
      evidenceCount: evidence.length, dateHint: hints.length > 0, dateHit, answer: outcome.answer ?? null })
  }
  return {
    cases: cases.length,
    completed: rows.filter(row => row.status === "complete").length,
    judgeFailures,
    accuracy: judged > 0 ? { judged, correct, value: correct / judged } : { judged: 0, correct: 0, value: null },
    retrieval: {
      evidencePresentRate: rows.length ? withEvidence / rows.length : null,
      dateHintCases, dateHintHits,
      dateHintHitRate: dateHintCases ? dateHintHits / dateHintCases : null,
      renderedEvidenceP50: percentile(renderedCounts, 0.5),
      renderedEvidenceMean: mean(renderedCounts),
    },
    byPersona: [...byPersona.values()].map(persona => ({ ...persona,
      accuracy: persona.judged > 0 ? persona.correct / persona.judged : null })),
    ingest, rows,
  }
}
