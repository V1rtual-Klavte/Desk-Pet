// 把逐题外部 yes/no 结果绑定到不可变的原始报告，并写出新派生报告。

import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { scoreLongMemEval } from "./datasets/longmemeval/scorer.mjs"
import { exportHypotheses } from "./export-hypotheses.mjs"
import { formatBenchSummary, parseBenchReportPayload, renderBenchHtmlReport, summarizeBenchReport } from "./report.mjs"

const sha256 = value => createHash("sha256").update(value).digest("hex")

function plannedCasesOf(report) {
  const subset = report.subsetDescription ?? {}
  const planned = Number(report.plannedCells)
  const ids = Array.isArray(subset.requestedCaseIds) ? subset.requestedCaseIds : []
  if (!Number.isInteger(planned) || planned < 0 || ids.length !== planned || new Set(ids).size !== ids.length
    || ids.some(id => typeof id !== "string" || !id))
    throw new Error("原始报告所选题 ID 与 plannedCells 不一致")

  const aggregateCounts = subset.countsByType
  const countsValid = aggregateCounts && typeof aggregateCounts === "object" && !Array.isArray(aggregateCounts)
    && !Object.values(aggregateCounts).some(value => !Number.isInteger(value) || value < 0)
    && Object.values(aggregateCounts).reduce((sum, value) => sum + value, 0) === planned
  const plannedCountsByType = countsValid ? aggregateCounts : null
  const aggregateAbstentionCount = Number.isInteger(subset.abstentionCount)
    && subset.abstentionCount >= 0 && subset.abstentionCount <= planned ? subset.abstentionCount : null
  let cases
  let mappingSource
  if (Array.isArray(subset.caseRefs)) {
    const refs = subset.caseRefs
    if (refs.length !== planned || new Set(refs.map(item => item.caseId)).size !== refs.length
      || refs.some(item => typeof item.caseId !== "string" || typeof item.questionType !== "string"
        || typeof item.abstention !== "boolean")
      || refs.some((item, index) => item.caseId !== ids[index]))
      throw new Error("原始报告 caseRefs 与 requestedCaseIds/plannedCells 不一致")
    cases = refs.map(item => ({ ...item,
      productUserFactEligible: item.questionType !== "single-session-assistant" }))
    mappingSource = "per-case caseRefs"
  } else {
    const observed = new Map((report.outcomes ?? []).map(outcome => [outcome.caseId, outcome]))
    if (countsValid) {
      const observedByType = new Map()
      let observedAbstentions = 0
      for (const caseId of ids) {
        const outcome = observed.get(caseId)
        const questionType = outcome?.caseRef?.questionType
        if (typeof questionType === "string") observedByType.set(questionType, (observedByType.get(questionType) ?? 0) + 1)
        if (outcome?.caseRef?.abstention === true) observedAbstentions += 1
      }
      for (const [questionType, count] of observedByType) {
        if (!Object.hasOwn(aggregateCounts, questionType) || count > aggregateCounts[questionType])
          throw new Error(`原始报告 countsByType 与已记录 caseRef 冲突: ${questionType}`)
      }
      if (aggregateAbstentionCount !== null && observedAbstentions > aggregateAbstentionCount)
        throw new Error("原始报告 abstentionCount 与已记录 caseRef 冲突")
    }
    cases = ids.map(caseId => {
      const outcome = observed.get(caseId)
      const questionType = typeof outcome?.caseRef?.questionType === "string" ? outcome.caseRef.questionType : null
      const abstention = typeof outcome?.caseRef?.abstention === "boolean" ? outcome.caseRef.abstention : null
      return { caseId, questionId: outcome?.questionId ?? outcome?.caseRef?.questionId ?? null,
        questionType, abstention,
        productUserFactEligible: questionType === null ? null : questionType !== "single-session-assistant" }
    })
    mappingSource = countsValid
      ? "legacy aggregate counts; unmapped IDs retain unknown per-case type/abstention"
      : "legacy outcome refs only; selected aggregate counts do not reconcile, unmapped IDs stay unknown"
  }
  return { cases, plannedCountsByType, abstentionCount: aggregateAbstentionCount, mappingSource }
}

function verdictOf(row) {
  if (row?.autoeval_label && typeof row.autoeval_label === "object") {
    const { model, label } = row.autoeval_label
    if (typeof model !== "string" || !model.trim() || typeof label !== "boolean")
      throw new Error("autoeval_label 必须包含 model 与 boolean label")
    return { correct: label, identity: model, method: "LongMemEval official evaluate_qa.py autoeval_label" }
  }
  const value = row?.verdict
  if (value === true || value === "yes") return { correct: true, identity: null, method: "manual yes/no verdict" }
  if (value === false || value === "no") return { correct: false, identity: null, method: "manual yes/no verdict" }
  throw new Error("判分行必须包含 official autoeval_label 或 verdict=yes/no")
}

function parseVerdictLog(text) {
  const rows = []
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line)) }
    catch (error) { throw new Error(`判分日志第 ${index + 1} 行不是 JSON: ${error.message}`) }
  }
  if (rows.length === 0) throw new Error("判分日志没有逐题 JSON 行")
  return rows
}

export function importExternalVerdicts(report, verdictRows, {
  sourceReportSha256, verdictLogSha256, judge, scope, judgedAt,
} = {}) {
  if (report?.schemaVersion !== "desk-pet-memory-bench/v1" || report.dataset !== "longmemeval")
    throw new Error("外部 autoeval_label 回填仅支持 LongMemEval memory-bench 原始报告")
  if (!Array.isArray(verdictRows) || verdictRows.length === 0) throw new Error("判分日志没有逐题 verdict")
  if (!/^[a-f0-9]{64}$/.test(sourceReportSha256 ?? "")) throw new TypeError("缺少原始报告 SHA-256")
  if (!/^[a-f0-9]{64}$/.test(verdictLogSha256 ?? "")) throw new TypeError("缺少判分日志 SHA-256")
  if (typeof scope !== "string" || !scope.trim()) throw new TypeError("必须写明判分 scope")
  if (typeof judgedAt !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(judgedAt)
    || !Number.isFinite(Date.parse(judgedAt)))
    throw new TypeError("judgedAt 必须是含时区的 ISO 8601 时间")
  const planned = plannedCasesOf(report)
  const selectedCases = planned.cases
  const selectedCaseIds = new Set(selectedCases.map(item => item.caseId))
  const outcomes = Array.isArray(report.outcomes) ? report.outcomes : []
  const expectedByQuestionId = new Map()
  const expectedCaseIds = new Set()
  for (const outcome of outcomes) {
    if (outcome.status !== "complete" || typeof outcome.answer !== "string") continue
    if (typeof outcome.caseId !== "string" || !outcome.caseId.trim()) throw new Error("complete outcome 缺少 caseId")
    if (!selectedCaseIds.has(outcome.caseId)) throw new Error(`complete outcome 不属于所选题集: ${outcome.caseId}`)
    const questionId = outcome.caseRef?.questionId ?? outcome.questionId
    if (typeof questionId !== "string" || !questionId.trim()) throw new Error(`${outcome.caseId}: complete outcome 缺少 questionId`)
    if (expectedCaseIds.has(outcome.caseId)) throw new Error(`原始报告 case_id 重复: ${outcome.caseId}`)
    expectedCaseIds.add(outcome.caseId)
    if (expectedByQuestionId.has(questionId)) throw new Error(`原始报告 question_id 重复: ${questionId}`)
    const expected = { caseId: outcome.caseId, questionId, hypothesis: outcome.answer,
      hypothesisSha256: sha256(outcome.answer) }
    expectedByQuestionId.set(questionId, expected)
  }
  if (expectedByQuestionId.size === 0) throw new Error("原始报告没有可回填的已完成回答")

  const seen = new Set()
  const imported = new Map()
  const sourceKinds = new Set()
  const officialIdentities = new Set()
  for (const row of verdictRows) {
    const questionId = row?.question_id
    if (typeof questionId !== "string" || !questionId.trim()) throw new Error("判分行缺少 question_id")
    if (seen.has(questionId)) throw new Error(`判分日志 question_id 重复: ${questionId}`)
    seen.add(questionId)
    const expected = expectedByQuestionId.get(questionId)
    if (!expected) throw new Error(`未知或没有可判回答的 question_id: ${questionId}`)
    if (row.autoeval_label && row.verdict !== undefined)
      throw new Error(`${questionId}: 不能同时包含官方 autoeval_label 与手工 verdict`)
    if (row.source_report_sha256 !== sourceReportSha256)
      throw new Error(`${questionId}: source_report_sha256 与原始报告不匹配`)
    if (row.case_id !== expected.caseId) throw new Error(`${questionId}: case_id 与导出 hypotheses 不匹配`)
    if (row.hypothesis_sha256 !== expected.hypothesisSha256)
      throw new Error(`${questionId}: hypothesis_sha256 与原始回答不匹配`)
    if (row.hypothesis !== expected.hypothesis) throw new Error(`${questionId}: hypothesis 文本与原始回答不匹配`)
    const verdict = verdictOf(row)
    sourceKinds.add(verdict.method)
    if (verdict.identity) officialIdentities.add(verdict.identity)
    imported.set(expected.caseId, { adjudicated: true, correct: verdict.correct,
      raw: verdict.correct ? "yes" : "no", source: "external",
      judge: verdict.identity ?? (typeof judge === "string" ? judge.trim() : null),
      method: verdict.method, scope: scope.trim(), judgedAt, hypothesisSha256: expected.hypothesisSha256,
      verdictLogSha256 })
  }
  if (sourceKinds.size !== 1) throw new Error("同一份回填日志不能混用官方 autoeval_label 与手工 verdict")
  if (officialIdentities.size > 1) throw new Error("判分日志包含多个 autoeval_label model")
  const method = [...sourceKinds][0]
  const officialIdentity = [...officialIdentities][0] ?? null
  if (officialIdentity && judge && judge !== officialIdentity)
    throw new Error(`--judge=${judge} 与 autoeval_label.model=${officialIdentity} 不一致`)
  if (officialIdentity && report.manifest?.model && officialIdentity === report.manifest.model)
    throw new Error("外部 judge 必须异构于报告中的被测模型")
  const judgeIdentity = officialIdentity ?? judge
  if (typeof judgeIdentity !== "string" || !judgeIdentity.trim())
    throw new TypeError("手工 yes/no 回填必须通过 --judge 指定判分者")

  const derivedOutcomes = outcomes.map(({ judgment, ...outcome }) => ({ ...outcome,
    localJudgment: judgment ?? outcome.localJudgment ?? null,
    judgment: null,
    externalJudgment: imported.get(outcome.caseId) ?? null }))
  const scoringOutcomes = derivedOutcomes.map(outcome => ({ ...outcome, judgment: null, externalJudgment: null }))
  const recomputed = scoreLongMemEval(selectedCases, scoringOutcomes,
    Object.fromEntries([...imported].map(([caseId, judgment]) => [caseId, judgment])), {
      plannedCountsByType: planned.plannedCountsByType,
      abstentionCount: planned.abstentionCount,
    })
  // 外部回填只替换答案结论；原 run 的确定性检索与 ingest 证据不动。
  recomputed.retrieval = report.scores?.retrieval ?? recomputed.retrieval
  recomputed.ingest = report.scores?.ingest ?? recomputed.ingest
  const exportedHypotheses = expectedByQuestionId.size
  const selectedCount = selectedCases.length
  const missingHypotheses = Math.max(0, selectedCount - exportedHypotheses)
  const missingVerdicts = exportedHypotheses - imported.size
  const derived = structuredClone(report)
  derived.outcomes = derivedOutcomes
  derived.scores = recomputed
  derived.externalAdjudication = {
    judge: judgeIdentity,
    method,
    scope: scope.trim(),
    judgedAt,
    importedAt: new Date().toISOString(),
    sourceReportSha256,
    verdictLogSha256,
    coverage: { selectedCases: selectedCount, hypothesesExported: exportedHypotheses,
      verdictsAccepted: imported.size, missingHypotheses, missingVerdicts,
      judgedOfSelected: `${imported.size}/${selectedCount}`,
      caseTypeMapping: planned.mappingSource,
      mappedCaseTypeCount: selectedCases.filter(item => typeof item.questionType === "string").length,
      unknownCaseTypeCount: selectedCases.filter(item => typeof item.questionType !== "string").length,
      mappedAbstentionCount: selectedCases.filter(item => typeof item.abstention === "boolean").length,
      unknownAbstentionCount: selectedCases.filter(item => typeof item.abstention !== "boolean").length },
    note: "仅有逐题且通过 report/case/question/hypothesis 哈希绑定的 yes/no 进入判分；无题级数据的汇总比例不推造逐题 verdict",
  }
  return derived
}

function parseOptions(args) {
  const values = new Map()
  const allowed = new Set(["--judge", "--scope", "--judged-at"])
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (!allowed.has(name)) throw new Error(`未知参数: ${name}`)
    if (values.has(name)) throw new Error(`参数重复: ${name}`)
    if (typeof value !== "string" || value.startsWith("--")) throw new Error(`${name} 缺少值`)
    values.set(name, value)
  }
  return values
}

function main() {
  const [reportInput, verdictPath, ...args] = process.argv.slice(2)
  if (!reportInput || !verdictPath || reportInput.startsWith("--") || verdictPath.startsWith("--"))
    throw new Error("用法: node test/memory-bench/import-verdicts.mjs <source-report.json> <official-results.jsonl|manual-verdicts.jsonl> --scope <说明> --judged-at <ISO> [--judge <身份>]")
  const reportPath = resolve(reportInput)
  const reportsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../reports/bench")
  if (dirname(reportPath) !== reportsDirectory)
    throw new Error("原始报告必须位于 test/reports/bench，派生产物才能遵循测试产物边界与报告保留组")
  const sourceName = basename(reportPath)
  if (!/^\d{4}-\d{2}-\d{2}T[\dTZ.-]+\.json$/.test(sourceName))
    throw new Error("原始报告必须是 test/reports/bench 下带日期戳的 .json，派生判分将随原报告一起保留")
  const sourceBytes = readFileSync(reportPath)
  const verdictBytes = readFileSync(verdictPath)
  const sourceReportSha256 = sha256(sourceBytes)
  const verdictLogSha256 = sha256(verdictBytes)
  const report = parseBenchReportPayload(sourceBytes.toString("utf8"))
  const argsByName = parseOptions(args)
  const verdictRows = parseVerdictLog(verdictBytes.toString("utf8"))
  const derived = importExternalVerdicts(report, verdictRows, {
    sourceReportSha256, verdictLogSha256, judge: argsByName.get("--judge"),
    scope: argsByName.get("--scope"), judgedAt: argsByName.get("--judged-at"),
  })
  const judgeHash = sha256(derived.externalAdjudication.judge).slice(0, 10)
  const logHash = verdictLogSha256.slice(0, 12)
  const hypothesesBytes = Buffer.from(exportHypotheses(report, { sourceReportSha256 })
    .map(line => JSON.stringify(line)).join("\n") + "\n")
  const hypothesesName = `${sourceName}.hypotheses-${sourceReportSha256.slice(0, 12)}.jsonl`
  const verdictLogName = `${sourceName}.verdicts-judge-${judgeHash}-${logHash}.jsonl`
  const hypothesesPath = join(reportsDirectory, hypothesesName)
  const verdictLogPath = join(reportsDirectory, verdictLogName)
  const stem = `${sourceName}.scored-judge-${judgeHash}-${logHash}`
  const out = join(dirname(reportPath), `${stem}.json`)
  const htmlPath = join(dirname(reportPath), `${stem}.html`)
  if (existsSync(out) || existsSync(htmlPath)) throw new Error("该判分者与日志的派生报告已存在；不会覆盖既有版本")
  for (const [path, expected] of [[hypothesesPath, hypothesesBytes], [verdictLogPath, verdictBytes]]) {
    if (existsSync(path) && !readFileSync(path).equals(expected))
      throw new Error(`同组外部判分输入已存在且内容不同: ${path}`)
  }
  if (!existsSync(hypothesesPath)) writeFileSync(hypothesesPath, hypothesesBytes, { flag: "wx" })
  if (!existsSync(verdictLogPath)) writeFileSync(verdictLogPath, verdictBytes, { flag: "wx" })
  derived.externalAdjudication.hypothesesFile = hypothesesName
  derived.externalAdjudication.hypothesesFileSha256 = sha256(hypothesesBytes)
  derived.externalAdjudication.verdictLogFile = verdictLogName
  const sourcePrefix = sourceBytes.toString("utf8").match(/^(?:PASS|FAIL)\r?\n/)?.[0] ?? ""
  const payload = `${sourcePrefix}${JSON.stringify(derived, null, 2)}\n`
  writeFileSync(out, payload, { flag: "wx" })
  const summary = summarizeBenchReport(derived)
  writeFileSync(htmlPath, renderBenchHtmlReport(derived, { reportPath: out }), { flag: "wx" })
  console.log(formatBenchSummary(summary, { reportPath: out, htmlPath }))
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  try { main() } catch (error) {
    console.error(`[memory-bench] 外部判分导入失败: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
