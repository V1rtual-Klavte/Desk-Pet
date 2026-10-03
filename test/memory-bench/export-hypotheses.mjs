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

import { readFileSync, writeFileSync } from "node:fs"

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

export function exportHypotheses(report) {
  const dataset = report.dataset
  const lines = []
  for (const outcome of report.outcomes ?? []) {
    if (outcome.status !== "complete") continue
    const line = hypothesisLine(dataset, outcome)
    if (line.hypothesis === null || line.hypothesis === undefined) continue
    lines.push(line)
  }
  return lines
}

function main() {
  const [reportPath, ...rest] = process.argv.slice(2)
  if (!reportPath || reportPath.startsWith("--")) throw new Error("用法: node export-hypotheses.mjs <report.json> [--out file.jsonl]")
  let out
  for (let index = 0; index < rest.length; index += 1) if (rest[index] === "--out") out = rest[++index]
  // 留存报告的固定前缀：e2e-result.txt 首行是 PASS/FAIL（与 memory-quality-review 同一剥法）。
  const report = JSON.parse(readFileSync(reportPath, "utf8").replace(/^(?:PASS|FAIL)\r?\n/, ""))
  const lines = exportHypotheses(report)
  const payload = lines.map(line => JSON.stringify(line)).join("\n") + "\n"
  if (out) { writeFileSync(out, payload); console.log(`[memory-bench] 已写出 ${lines.length} 条 hypotheses 到 ${out}`) }
  else process.stdout.write(payload)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main() } catch (error) {
    console.error(`[memory-bench] export-hypotheses 失败: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
