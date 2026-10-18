// Execute revision-locked upstream evaluation scripts on exported hypotheses.

import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve, join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = dirname(fileURLToPath(import.meta.url))
const LOCK = JSON.parse(readFileSync(join(ROOT, "upstream-lock.json"), "utf8"))
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex")
const LONGMEMEVAL_METRIC_MODELS = new Map([
  ["gpt-4o-mini", "gpt-4o-mini-2024-07-18"],
  ["gpt-4o", "gpt-4o-2024-08-06"],
  ["llama-3.1-70b-instruct", "meta-llama/Meta-Llama-3.1-70B-Instruct"],
])

function parseArgs(argv) {
  const [dataset, hypotheses, ...rest] = argv
  if (!dataset || !hypotheses || dataset !== "longmemeval")
    throw new Error("用法: node test/memory-bench/run-official.mjs longmemeval <hypotheses.jsonl> [--data-dir PATH] [--split oracle|s] [--metric-model gpt-4o-mini]")
  const options = new Map()
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index]
    const value = rest[index + 1]
    if (!["--data-dir", "--split", "--metric-model"].includes(name)) throw new Error(`未知参数: ${name}`)
    if (options.has(name)) throw new Error(`参数重复: ${name}`)
    if (!value || value.startsWith("--")) throw new Error(`${name} 缺少值`)
    options.set(name, value)
  }
  return { dataset, hypotheses: resolve(hypotheses), options }
}

function lockedInput(dataDir, key) {
  const entry = LOCK.downloads[key]
  const path = join(dataDir, entry.path)
  if (!existsSync(path)) throw new Error(`锁定输入未安装：${entry.path}；先运行 prepare.mjs`)
  const bytes = readFileSync(path)
  if (sha256(bytes) !== entry.sha256) throw new Error(`锁定输入 SHA-256 不匹配：${entry.path}`)
  return { path, bytes, entry }
}

function hypothesisRows(path) {
  const rows = readFileSync(path, "utf8").split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) }
    catch (error) { throw new Error(`hypotheses 第 ${index + 1} 行不是 JSON: ${error.message}`) }
  })
  if (!rows.length) throw new Error("hypotheses 文件为空")
  const seen = new Set()
  for (const row of rows) {
    const id = row.question_id
    if (typeof id !== "string" || !id || seen.has(id)) throw new Error("hypotheses question_id 缺失或重复")
    seen.add(id)
    if (typeof row.case_id !== "string" || row.case_id_sha256 !== sha256(Buffer.from(row.case_id, "utf8"))
      || typeof row.hypothesis !== "string"
      || row.hypothesis_sha256 !== sha256(Buffer.from(row.hypothesis, "utf8"))
      || !/^[a-f0-9]{64}$/u.test(row.source_report_sha256 ?? ""))
      throw new Error(`${id}: hypotheses 的 case/source/hash 字段非法`)
  }
  return rows
}

function run(python, args) {
  const result = spawnSync(python, args, { stdio: "inherit", env: process.env })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`官方评分脚本退出码 ${result.status ?? "unknown"}`)
}

function main() {
  const { dataset, hypotheses, options } = parseArgs(process.argv.slice(2))
  const dataDir = resolve(options.get("--data-dir") ?? process.env.DESKPET_BENCH_DATA_DIR ?? join(ROOT, ".data"))
  const python = process.env.DESKPET_BENCH_PYTHON ?? "python3"
  const rows = hypothesisRows(hypotheses)

  const split = options.get("--split") ?? "oracle"
  const downloadName = split === "oracle" ? "longmemeval_oracle"
    : split === "s" ? "longmemeval_s_cleaned" : undefined
  if (!downloadName) throw new Error("LongMemEval split 必须为 oracle 或 s")
  const { path: referencePath } = lockedInput(dataDir, "longmemeval_evaluate_qa")
  const { path: rawPath, entry: dataEntry } = lockedInput(dataDir, downloadName)
  const metricModel = options.get("--metric-model") ?? "gpt-4o-mini"
  const canonicalMetricModel = LONGMEMEVAL_METRIC_MODELS.get(metricModel)
  if (!canonicalMetricModel)
    throw new Error(`LongMemEval 官方 evaluator 不支持该 metric model：${metricModel}；支持 ${[...LONGMEMEVAL_METRIC_MODELS.keys()].join(", ")}`)
  const expectedOutput = `${hypotheses}.eval-results-${metricModel}`
  if (existsSync(expectedOutput)) throw new Error(`官方评分输出已存在，拒绝覆盖：${expectedOutput}`)
  const auditOutput = `${expectedOutput}.official-longmemeval.jsonl`
  if (existsSync(auditOutput)) throw new Error(`官方审计派生输出已存在，拒绝覆盖：${auditOutput}`)
  run(python, [referencePath, metricModel, hypotheses, rawPath])
  if (!existsSync(expectedOutput)) throw new Error(`LongMemEval 官方脚本没有写出预期结果：${expectedOutput}`)
  const evaluatorEntry = LOCK.downloads.longmemeval_evaluate_qa
  const runMetadata = {
    dataset: "longmemeval",
    split,
    evaluator: { revision: evaluatorEntry.revision, sha256: evaluatorEntry.sha256 },
    data: { revision: dataEntry.revision, sha256: dataEntry.sha256 },
    metricModel: { requested: metricModel, canonical: canonicalMetricModel },
  }
  const resultRows = readFileSync(expectedOutput, "utf8").split(/\r?\n/u).filter(Boolean).map((line, index) => {
    let row
    try { row = JSON.parse(line) }
    catch (error) { throw new Error(`官方结果第 ${index + 1} 行不是 JSON: ${error.message}`) }
    if (row.autoeval_label?.model !== canonicalMetricModel)
      throw new Error(`官方结果第 ${index + 1} 行的 autoeval_label.model 与锁定官方模型映射不一致`)
    return { ...row, official_run: runMetadata }
  })
  if (resultRows.length !== rows.length) throw new Error(`LongMemEval 官方结果题数不一致：${resultRows.length}/${rows.length}`)
  writeFileSync(auditOutput, `${resultRows.map(row => JSON.stringify(row)).join("\n")}\n`, { flag: "wx" })
  console.log(`[memory-bench] LongMemEval 官方 evaluate_qa.py 完成：${rows.length} 条 hypotheses；保留原生结果 ${expectedOutput}，审计派生 ${auditOutput}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { main() }
  catch (error) {
    console.error(`[memory-bench] official runner 失败: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
