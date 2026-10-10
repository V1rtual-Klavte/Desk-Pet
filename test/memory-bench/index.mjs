// ==========================================
// 外部记忆基准 runner（宿主无关；cell 执行在 bench-adapter）
// ==========================================
//
// 与自建 80 题（test/memory-quality）物理隔离：独立 schema（desk-pet-memory-bench/v1）、
// 独立命令（pnpm test:memory-bench）、不进 CI / test:release、质量阈值字段置 null。
// 本模块只做：案例文件校验 → cell 规划 → 逐题执行编排 → 失败中止 → 报告组装。
// 纯函数可被 L2 单测直接驱动（fake adapter）。

import { shuffled, summarizeMemoryQualityUsage } from "../memory-quality/index.mjs"
import { validateLongMemEvalFile } from "./datasets/longmemeval/importer.mjs"
import { scoreLongMemEval } from "./datasets/longmemeval/scorer.mjs"
import { validateLocomoFile } from "./datasets/locomo/importer.mjs"
import { scoreLocomo } from "./datasets/locomo/scorer.mjs"
import { validateMemoryBankFile } from "./datasets/memorybank/importer.mjs"
import { scoreMemoryBank } from "./datasets/memorybank/scorer.mjs"

export const BENCH_SCHEMA_VERSION = "desk-pet-memory-bench/v1"

/**
 * 数据集注册表（宿主侧）：namespace/label/defaultSplit 与数据安装解耦。
 * 数据文件不进仓库（见 README）：由 prepare.mjs 按 `upstream-lock.json` 安装到开发者
 * 指定的 data-dir，启动器把请求的案例文件 stage 成隔离数据根的 `bench/cases.json`，
 * 宿主只从固定路径读取；split 键必须与 upstream-lock.json 保持同步（有单测守护）。
 */
export const BENCH_DATASETS = Object.freeze({
  longmemeval: {
    name: "LongMemEval（cleaned）",
    defaultSplit: "oracle",
    splits: {
      oracle: { namespace: "lme-oracle", label: "oracle 子集（52 题，6 类 + 10 弃权）" },
      s: { namespace: "lme-s", label: "S-cleaned 子集（长上下文，默认不跑）" },
    },
  },
  locomo: {
    name: "LoCoMo",
    defaultSplit: "locomo10",
    splits: { locomo10: { namespace: "locomo", label: "locomo10 全量 10 段对话 / 1986 QA" } },
  },
  memorybank: {
    name: "MemoryBank cn",
    defaultSplit: "cn",
    splits: { cn: { namespace: "membank-cn", label: "cn 全量 15 角色 / 100 探测题" } },
  },
})

export function benchSplitInfo(dataset, split) {
  const entry = BENCH_DATASETS[dataset]
  if (!entry) throw new Error(`未登记的数据集: ${dataset}（可用: ${Object.keys(BENCH_DATASETS).join(" / ")}）`)
  const resolvedSplit = split ?? entry.defaultSplit
  const info = entry.splits[resolvedSplit]
  if (!info) throw new Error(`数据集 ${dataset} 没有 split ${resolvedSplit}（可用: ${Object.keys(entry.splits).join(" / ")}）`)
  return { dataset, split: resolvedSplit, namespace: info.namespace, label: info.label, datasetName: entry.name }
}

export function validateBenchCaseFile(dataset, file) {
  if (file?.schemaVersion !== "desk-pet-memory-bench-cases/v1")
    return [`案例文件 schemaVersion 不匹配: ${file?.schemaVersion ?? "<empty>"}`]
  if (file.dataset !== dataset) return [`案例文件 dataset=${file.dataset} 与请求的 ${dataset} 不一致`]
  if (dataset === "longmemeval") return validateLongMemEvalFile(file)
  if (dataset === "locomo") return validateLocomoFile(file)
  if (dataset === "memorybank") return validateMemoryBankFile(file)
  return [`未登记的数据集: ${dataset}`]
}

function groupKeyOf(dataset, item) {
  if (dataset === "locomo") return item.sampleId
  if (dataset === "memorybank") return item.persona
  return item.caseId
}

/**
 * cell 规划：按组连续性排序（LoCoMo 一段对话只灌一次库），组内用 seed 洗牌，
 * 再截断 limit —— limit 语义是「本次最多跑几题」，且不会从组中间切开。
 */
export function planBenchCells(dataset, file, { limit, caseFilter, seed } = {}) {
  let cases = file.cases
  if (Array.isArray(caseFilter) && caseFilter.length > 0) {
    const wanted = new Set(caseFilter)
    cases = cases.filter(item => wanted.has(item.caseId))
    if (cases.length === 0) throw new RangeError(`caseFilter 没有命中任何题目: ${caseFilter.join(", ")}`)
  }
  const groups = new Map()
  for (const item of cases) {
    const key = groupKeyOf(dataset, item)
    const bucket = groups.get(key) ?? []
    bucket.push(item)
    groups.set(key, bucket)
  }
  const ordered = [...groups.values()].flatMap(bucket => shuffled(bucket, `${seed}/${groupKeyOf(dataset, bucket[0])}`))
  const selected = typeof limit === "number" && Number.isFinite(limit) ? ordered.slice(0, Math.max(0, limit)) : ordered
  return selected.map((item, index) => ({ caseId: item.caseId, groupKey: groupKeyOf(dataset, item),
    questionId: typeof item.questionId === "string" ? item.questionId : null,
    caseDef: item, sequence: index + 1, total: selected.length }))
}

/** 报告内 outcome 携带的最小案例引用（导出 hypotheses 与人工复核都从这里取题面）。 */
function caseRefOf(dataset, caseDef) {
  if (dataset === "longmemeval")
    return { questionId: caseDef.questionId, question: caseDef.question, questionType: caseDef.questionType,
      abstention: caseDef.abstention === true }
  if (dataset === "locomo")
    return { sampleId: caseDef.sampleId, questionIndex: caseDef.questionIndex, question: caseDef.question, category: caseDef.category }
  return { persona: caseDef.persona, questionIndex: caseDef.questionIndex, question: caseDef.question }
}

function judgeInputFor(dataset, file, caseDef, outcome) {
  if (dataset === "longmemeval")
    return { kind: "longmemeval", questionType: caseDef.questionType, question: caseDef.question,
      answer: caseDef.answer, response: outcome.answer ?? "", abstention: caseDef.abstention === true }
  if (dataset === "memorybank") {
    const persona = file.personas.find(item => item.name === caseDef.persona)
    if (!persona) throw new Error(`${caseDef.caseId}: 找不到角色 ${caseDef.persona}`)
    return { kind: "memorybank", persona, question: caseDef.question, response: outcome.answer ?? "" }
  }
  throw new Error(`dataset ${dataset} 不需要 judge`)
}

/** 同一数据集的判分调度；judgments 缺省时只出检索确定性指标。 */
export function scoreBenchDataset(dataset, file, outcomes, judgments = {}, cases = file.cases) {
  if (dataset === "longmemeval") return scoreLongMemEval(cases, outcomes, judgments)
  if (dataset === "locomo") return scoreLocomo(cases, outcomes)
  if (dataset === "memorybank") return scoreMemoryBank(cases, outcomes, judgments)
  throw new Error(`未登记的判分数据集: ${dataset}`)
}

export async function runMemoryBenchEvaluation({
  adapter, dataset, split, file, seed, limit, caseFilter, judge = "on", judgeModel, signal, onCellStart, onCellEnd,
} = {}) {
  const info = benchSplitInfo(dataset, split)
  if (!adapter || typeof adapter.runCell !== "function") throw new TypeError("adapter.runCell is required")
  if (seed === undefined || seed === null || String(seed).length === 0) throw new TypeError("seed is required")
  const errors = validateBenchCaseFile(dataset, file)
  if (errors.length) throw new Error(`memory bench 案例文件非法: ${errors.join("; ")}`)
  const judgeEnabled = judge !== "off" && judge !== false && dataset !== "locomo"
  if (judgeEnabled && (typeof judgeModel !== "string" || !judgeModel.trim()))
    throw new TypeError("judge 开启时必须提供 judgeModel")
  const cells = planBenchCells(dataset, file, { limit, caseFilter, seed })
  const reportNamespace = adapter.reportNamespace?.() ?? info.namespace
  const evalRunId = `bench-${reportNamespace}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`
  const startedAt = new Date().toISOString()
  await adapter.init?.({ dataset, split: info.split, file, evalRunId })
  const outcomes = []
  const failures = []
  let attempted = 0
  let consecutiveInfrastructureFailures = 0
  for (const cell of cells) {
    if (consecutiveInfrastructureFailures >= 3) {
      failures.push({ kind: "aborted", message: "three consecutive infrastructure failures; remaining cells were not executed",
        remainingCells: cells.length - attempted })
      break
    }
    if (signal?.aborted) {
      failures.push({ kind: "cancelled", message: "evaluation cancelled", remainingCells: cells.length - attempted })
      break
    }
    attempted += 1
    const context = { evalRunId, dataset, split: info.split, caseId: cell.caseId, questionId: cell.questionId,
      groupKey: cell.groupKey, sequence: cell.sequence, total: cell.total }
    try {
      await onCellStart?.(context)
      const outcome = await adapter.runCell({ ...context, caseDef: cell.caseDef, seed: String(seed), signal })
      if (!outcome || outcome.caseId !== cell.caseId) throw new Error("adapter returned a mismatched case identity")
      let judgment = null
      if (judgeEnabled && outcome.status === "complete") {
        // judge 失败不推翻已完成的采集；如实记录为未裁决，不进正确率分母。
        try {
          judgment = await adapter.judgeCase({ ...context, caseDef: cell.caseDef, outcome,
            input: judgeInputFor(dataset, file, cell.caseDef, outcome), judgeModel, signal })
        } catch (error) {
          judgment = { adjudicated: false, error: String(error?.message ?? error) }
        }
      }
      consecutiveInfrastructureFailures = 0
      outcomes.push({ ...outcome, groupKey: cell.groupKey, caseRef: caseRefOf(dataset, cell.caseDef), judgment })
      await onCellEnd?.({ ...context, status: outcome.status, outcome, judgment })
    } catch (error) {
      const failure = { caseId: cell.caseId, groupKey: cell.groupKey, kind: "infrastructure",
        message: String(error?.message ?? error) }
      failures.push(failure)
      consecutiveInfrastructureFailures += 1
      try {
        await onCellEnd?.({ ...context, status: "inconclusive", error: failure })
      } catch (callbackError) {
        failures.push({ ...failure, kind: "trace-callback", message: String(callbackError?.message ?? callbackError) })
      }
    }
  }
  await adapter.finalize?.()
  const judgments = {}
  for (const outcome of outcomes) if (outcome.judgment) judgments[outcome.caseId] = outcome.judgment
  const complete = outcomes.length === cells.length && failures.length === 0
    && outcomes.every(outcome => outcome.status === "complete")
  const report = {
    schemaVersion: BENCH_SCHEMA_VERSION,
    source: "external",
    status: "observational",
    dataset,
    split: info.split,
    splitLabel: info.label,
    namespace: reportNamespace,
    evalRunId, seed: String(seed), startedAt, finishedAt: new Date().toISOString(),
    upstream: file.upstream ?? null,
    license: file.license ?? null,
    importTransformVersion: file.importTransformVersion ?? null,
    judge: { enabled: judgeEnabled, model: judgeEnabled ? judgeModel : null },
    judgeModel: judgeEnabled ? judgeModel : null,
    subsetDescription: { policy: file.selection?.policy ?? null, caseCount: cells.length,
      requestedCaseIds: cells.map(cell => cell.caseId), fileCaseCount: file.cases.length,
      caseRefs: cells.map(cell => ({ caseId: cell.caseId, questionId: cell.questionId,
        questionType: cell.caseDef.questionType ?? null, abstention: cell.caseDef.abstention === true,
        productUserFactEligible: dataset === "longmemeval" && cell.caseDef.questionType !== "single-session-assistant" })),
      countsByType: dataset === "longmemeval" ? cells.reduce((counts, cell) => {
        const questionType = cell.caseDef.questionType
        counts[questionType] = (counts[questionType] ?? 0) + 1
        return counts
      }, {}) : file.selection?.countsByType ?? null,
      abstentionCount: cells.filter(cell => cell.caseDef.abstention === true).length },
    // 外部基准是观测证据：不设质量阈值，字段显式为 null（区别于自建 80 题的门禁）。
    qualityThresholds: null,
    gates: { complete, infrastructureFailures: failures.filter(failure => failure.kind !== "cancelled").length },
    manifest: await adapter.manifest?.() ?? null,
    plannedCells: cells.length,
    // attempted = 实际进入执行的 cell（包括抛错而未产生 outcome 的基础设施失败）。
    attemptedCells: attempted,
    completedCells: outcomes.filter(outcome => outcome.status === "complete").length,
    failures,
    outcomes,
    scores: scoreBenchDataset(dataset, file, outcomes, judgments, cells.map(cell => cell.caseDef)),
  }
  return report
}
