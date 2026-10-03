// ==========================================
// LoCoMo 判分器（官方 task_eval/evaluation.py 的仓内移植）
// ==========================================
//
// 移植要点（与官方逐条对齐）：
//   · normalize_answer：先删除所有逗号 → 小写 → 删除 ASCII 标点 → 删除 a/an/the/and → 折叠空白；
//   · f1_score：对已归一化的 token 做 Porter 词干化，按词频交集计 precision/recall；
//   · 多跳（category 1）：把预测与金标都按逗号拆子句，对每个金标子句取「预测子句最高 f1」，再平均；
//   · category 3 金标先在 `;` 处截断；
//   · category 5 对抗题二值：回答包含 no information available / not mentioned 记 1，否则 0。
// 报告口径：本仓适配移植，不是官方脚本运行产物；差异（词干器实现、JS 标点集）见 README。

import { porterStem } from "./porter.mjs"

const ASCII_PUNCTUATION = new Set(`!"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~`.split(""))

export function normalizeLocomoAnswer(s) {
  return String(s ?? "")
    .replace(/,/g, "")
    .toLowerCase()
    .split("")
    .filter(ch => !ASCII_PUNCTUATION.has(ch))
    .join("")
    .replace(/\b(a|an|the|and)\b/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ")
}

function tokenCounts(tokens) {
  const counts = new Map()
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
  return counts
}

export function locomoF1Score(prediction, groundTruth) {
  const predictionTokens = normalizeLocomoAnswer(prediction).split(" ").filter(Boolean).map(porterStem)
  const groundTruthTokens = normalizeLocomoAnswer(groundTruth).split(" ").filter(Boolean).map(porterStem)
  const predictionCounts = tokenCounts(predictionTokens)
  const groundTruthCounts = tokenCounts(groundTruthTokens)
  let same = 0
  for (const [token, count] of predictionCounts) same += Math.min(count, groundTruthCounts.get(token) ?? 0)
  if (same === 0 || predictionTokens.length === 0 || groundTruthTokens.length === 0) return 0
  const precision = same / predictionTokens.length
  const recall = same / groundTruthTokens.length
  return (2 * precision * recall) / (precision + recall)
}

/** 官方 f1()：逗号拆子句，对每个金标子句取预测子句的最高分，再平均。 */
export function locomoMultiHopF1(prediction, groundTruth) {
  const predictions = String(prediction ?? "").split(",").map(part => part.trim())
  const groundTruths = String(groundTruth ?? "").split(",").map(part => part.trim())
  if (groundTruths.length === 0) return 0
  const scores = groundTruths.map(gt => Math.max(...predictions.map(part => locomoF1Score(part, gt))))
  return scores.reduce((sum, value) => sum + value, 0) / scores.length
}

export function scoreLocomoAnswer(category, prediction, answer) {
  if (category === 1) return locomoMultiHopF1(prediction, answer)
  if (category === 2 || category === 3 || category === 4) {
    const groundTruth = category === 3 ? String(answer ?? "").split(";")[0].trim() : answer
    return locomoF1Score(prediction, groundTruth)
  }
  if (category === 5) {
    const output = String(prediction ?? "").toLowerCase()
    return output.includes("no information available") || output.includes("not mentioned") ? 1 : 0
  }
  throw new Error(`LoCoMo category 非法: ${category}`)
}

function mean(values) {
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

export function scoreLocomo(cases, outcomes) {
  const byId = new Map(cases.map(item => [item.caseId, item]))
  const rows = []
  const byCategory = new Map()
  const evidenceRecalls = []
  const ingest = { registeredSources: 0, processedSources: 0, oversizedSources: 0, sweeps: 0 }
  for (const outcome of outcomes) {
    const item = byId.get(outcome.caseId)
    if (!item) continue
    const scored = outcome.status === "complete" ? scoreLocomoAnswer(item.category, outcome.answer, item.answer) : null
    if (scored !== null) {
      const bucket = byCategory.get(item.category) ?? []
      bucket.push(scored)
      byCategory.set(item.category, bucket)
    }
    const rendered = new Set((outcome.evidence ?? []).map(ref => ref.diaId).filter(Boolean))
    const gold = item.evidence ?? []
    if (gold.length > 0) {
      const hits = gold.filter(diaId => rendered.has(diaId)).length
      evidenceRecalls.push(hits / gold.length)
    }
    const stats = outcome.ingest ?? {}
    ingest.registeredSources += stats.registeredSources ?? 0
    ingest.processedSources += stats.processedSources ?? 0
    ingest.oversizedSources += stats.oversizedSources ?? 0
    ingest.sweeps += stats.sweeps ?? 0
    rows.push({ caseId: item.caseId, sampleId: item.sampleId, category: item.category, status: outcome.status,
      score: scored, evidenceRecall: gold.length ? (outcome.evidence ?? []).filter(ref => gold.includes(ref.diaId)).length / gold.length : null,
      answer: outcome.answer ?? null })
  }
  const categoryRows = [...byCategory.entries()].sort((left, right) => left[0] - right[0])
    .map(([category, values]) => ({ category, count: values.length, meanScore: mean(values) }))
  return {
    cases: cases.length, scored: rows.filter(row => row.score !== null).length,
    meanScore: mean(rows.map(row => row.score).filter(value => value !== null)),
    byCategory: categoryRows,
    evidenceRecallMean: mean(evidenceRecalls),
    ingest, rows,
  }
}
