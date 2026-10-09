// ==========================================
// 从 bench 报告导出官方复判用的 hypotheses JSONL
// ==========================================
//
// 用途：仓内 judge 只是「基于官方模板的自适配」；需要官方脚本复判时，
// 用本脚本把已留存报告的每题回答导成官方格式，再跑官方脚本：
//   · LongMemEval：输出 {"question_id","hypothesis"} 行，直接喂官方
//     src/evaluation/evaluate_qa.py <metric_model> <hyp_file> <ref_file>；
//   · LoCoMo：输出 {"sampleId","questionIndex","question","hypothesis","category"} 行（官方仓库没有消费该格式的脚本，供自建对照）；
//   · MemoryBank：输出 {"persona","question","hypothesis"} 行（上游没有判分脚本）。
//
// 用法：node test/memory-bench/export-hypotheses.mjs <report.json> [--out file.jsonl]
// 报告 = pnpm run test:memory-bench 输出的 test/reports/<stamp>.json（或 bundle 里同内容）；
// 也可以直接使用 bundle 中的 memory-bench-outcomes.jsonl（LongMemEval 行已含 question_id/hypothesis）。

import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

function hypothesisLine(dataset, outcome) {
  const ref = outcome.caseRef ?? {}
  if (dataset === "longmemeval")
    return { question_id: ref.questionId ?? outcome.questionId ?? null, hypothesis: outcome.answer ?? null }
  if (dataset === "locomo")
    return { caseId: outcome.caseId, sampleId: ref.sampleId ?? outcome.groupKey, questionIndex: ref.questionIndex ?? null,
      question: ref.question ?? null, hypothesis: outcome.answer ?? null, category: ref.category ?? null }
  if (dataset === "memorybank")
    return { caseId: outcome.caseId, persona: ref.persona ?? outcome.groupKey, question: ref.question ?? null,
      hypothesis: outcome.answer ?? null }
  throw new Error(`未登记的数据集: ${dataset}`)
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

export function exportHypotheses(report, { sourceReportSha256 } = {}) {
  if (typeof sourceReportSha256 !== "string" || !/^[a-f0-9]{64}$/.test(sourceReportSha256))
    throw new TypeError("sourceReportSha256 必须是原始报告字节的 SHA-256")
  const dataset = report.dataset
  const lines = []
  const rowIds = new Set()
  for (const outcome of report.outcomes ?? []) {
    if (outcome.status !== "complete") continue
    const line = hypothesisLine(dataset, outcome)
    if (typeof line.hypothesis !== "string") continue
    if (typeof outcome.caseId !== "string" || !outcome.caseId.trim())
      throw new Error("complete outcome 缺少 caseId，无法绑定外部判分")
    const rowId = line.question_id ?? outcome.caseId
    if (typeof rowId !== "string" || !rowId.trim())
      throw new Error(`${outcome.caseId}: 缺少唯一逐题 ID，无法绑定外部判分`)
    if (rowIds.has(rowId)) throw new Error(`报告中逐题 ID 重复: ${rowId}`)
    rowIds.add(rowId)
    line.case_id = outcome.caseId
    line.source_report_sha256 = sourceReportSha256
    line.hypothesis_sha256 = sha256(line.hypothesis)
    if (dataset === "longmemeval") {
      if (typeof line.question_id !== "string" || !line.question_id.trim())
        throw new Error(`${outcome.caseId}: 缺少唯一 question_id，无法绑定外部判分`)
    }
    lines.push(line)
  }
  return lines
}

function main() {
  const [reportInput, ...args] = process.argv.slice(2)
  if (!reportInput || reportInput.startsWith("--")) throw new Error("用法: node export-hypotheses.mjs <bench-report.json> [--out file.jsonl]")
  let outInput
  for (let index = 0; index < args.length; index += 2) {
    if (args[index] !== "--out") throw new Error(`未知参数: ${args[index]}`)
    if (outInput !== undefined) throw new Error("参数重复: --out")
    if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error("--out 缺少值")
    outInput = args[index + 1]
  }
  const reportPath = resolve(reportInput)
  const reportDir = dirname(reportPath)
  const expectedDir = resolve(dirname(fileURLToPath(import.meta.url)), "../reports/bench")
  const reportName = basename(reportPath)
  if (reportDir !== expectedDir || !/^\d{4}-\d{2}-\d{2}T[\dTZ.-]+\.json$/.test(reportName))
    throw new Error("原始报告必须是 test/reports/bench 下带日期戳的 .json，hypotheses 将随报告同组保留")
  const sourceBytes = readFileSync(reportPath)
  // 留存报告的固定前缀：e2e-result.txt 首行是 PASS/FAIL（与 memory-quality-review 同一剥法）。
  const report = JSON.parse(sourceBytes.toString("utf8").replace(/^(?:PASS|FAIL)\r?\n/, ""))
  const sourceReportSha256 = createHash("sha256").update(sourceBytes).digest("hex")
  const lines = exportHypotheses(report, { sourceReportSha256 })
  const payload = lines.map(line => JSON.stringify(line)).join("\n") + "\n"
  const out = outInput ? resolve(outInput) : join(reportDir, `${reportName}.hypotheses-${sourceReportSha256.slice(0, 12)}.jsonl`)
  if (dirname(out) !== reportDir || !/^.+\.json\.hypotheses-[a-z0-9-]+\.jsonl$/.test(basename(out)))
    throw new Error("hypotheses 输出必须是原报告同目录下的 .json.hypotheses-<id>.jsonl 卫星")
  const bytes = Buffer.from(payload)
  if (existsSync(out)) {
    if (!readFileSync(out).equals(bytes)) throw new Error(`hypotheses 文件已存在且内容不同: ${out}`)
  } else writeFileSync(out, bytes, { flag: "wx" })
  console.log(`[memory-bench] 已写出 ${lines.length} 条 hypotheses 到 ${out}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main() } catch (error) {
    console.error(`[memory-bench] export-hypotheses 失败: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
