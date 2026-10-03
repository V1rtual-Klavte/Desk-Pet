// ==========================================
// Live Test 宿主入口（分派与汇总，场景执行在 scene-runner）
// 开发工具直接用 console：改走 logger 会污染 data_root/logs/deskpet.log
// 并引入 IPC 依赖 [保留已登记 §4.2]
// ==========================================

import { invoke } from "@tauri-apps/api/core"
import { validateDataset, LIVE_DATASET_VERSION } from "./dataset"
import { runAllScenes, plannedTrialCount } from "./scene-runner"
import { standardSetup } from "../host/standard-setup"
import { formatReport } from "./reporter"
import { createProgressView, formatSceneFailure, formatTraceEvents, TRACE_WINDOW_SIZE } from "./progress"
import type { ProgressView } from "./progress"
import { checkAllContracts } from "../host/contract-checker"
import { parseArgs } from "./cli"
import type { ModuleContract } from "../host/types"
import type { SceneDef, TestReport } from "./types"
import { initPaths, runtimePath } from "@/services/paths"
import { aiConfig, flushConfig, initConfig, setOverrides } from "@/services/config"
import { parseEvalModelsFile, resolveEvalModels } from "./eval-models"
import type { EvalModelsFile } from "./eval-models"
import { installGlobalHandlers, reportError, formatError } from "@/services/error"
import { createLogger } from "@/services/logger"
import { createLiveTraceRecorder } from "../host/trace-observer"
import { runMemoryPerformanceEvaluation } from "./memory-performance"
import { createLiveMemoryQualityAdapter } from "../memory-quality/live-adapter"
import { runMemoryQualityEvaluation, MEMORY_QUALITY_CASES, MEMORY_QUALITY_STRATEGIES } from "../memory-quality/index.mjs"
import type { MemoryQualityCellContext } from "../memory-quality/live-adapter"
import { createLiveMemoryBenchAdapter } from "../memory-bench/bench-adapter"
import { runMemoryBenchEvaluation, planBenchCells, benchSplitInfo } from "../memory-bench/index.mjs"
import type { BenchCaseFile, BenchCellContext, BenchReport } from "../memory-bench/index.mjs"

interface RuntimeOptions {
  module?: string
  scene?: string
  case?: string
  tag?: string
  suite?: string
  repeat?: string
  strict?: string
  report?: string
  seedHash?: string
  sourceHashes?: string
  commit?: string
  quality?: string
  qualitySeed?: string
  performance?: string
  trace?: string
  bench?: string
  benchDataset?: string
  benchSplit?: string
  benchLimit?: string
  benchCase?: string
  benchSeed?: string
  benchJudge?: string
  benchJudgeModel?: string
  evalProvider?: string
  evalModel?: string
  evalJudgeModel?: string
}

const sceneModules = import.meta.glob<{ default?: SceneDef }>("./scenes/**/*.scene.ts", { eager: true })
const contractModules = import.meta.glob<Record<string, ModuleContract>>("../contracts/*.contract.ts", { eager: true })

function collectScenes(): SceneDef[] {
  // 不按 caseId 去重：那会让重复 caseId 里后出现的场景静默消失，validateDataset 的
  // 「caseId 重复」分支因此永远不可达（报告照样全绿）。
  // 但同一个 SceneDef 会经多个导出名出现：`export const X` 与 `export default X` 指向
  // 同一对象（多场景文件与单场景文件都这么写），历史上还有转发别名文件。
  // 这里只按对象身份收敛这些别名，不按 caseId 收敛 —— 两个不同场景撞同一个 caseId
  // 仍然原样进 validateDataset，由它报错。
  const scenes = Object.values(sceneModules)
    .flatMap(module => Object.values(module))
    .filter((scene): scene is SceneDef => Boolean(scene && typeof scene === "object" && "meta" in scene && scene.meta))
  return [...new Set(scenes)]
}

function collectContracts(): ModuleContract[] {
  const contracts = Object.values(contractModules)
    .flatMap(module => Object.values(module))
    .filter((contract): contract is ModuleContract => Boolean(contract?.module && contract?.coverage))
  return [...new Map(contracts.map(contract => [contract.module, contract])).values()]
}

/**
 * 解析启动脚本通过环境变量送进来的 sourceHash 证明。
 * 形状不对（或没值）就当作「没有证明」，由 contract-checker 判为 stale，
 * 不在这里猜测 —— 猜错的方向是「假通过」，代价比多跑一次预检高。
 */
function parseHashAttestation(raw?: string): Record<string, string> | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const entries = Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    return entries.length > 0 ? Object.fromEntries(entries) : undefined
  } catch {
    return undefined
  }
}

function withStandardSetup(scene: SceneDef): SceneDef {
  const sceneSetup = scene.setup
  return {
    ...scene,
    setup: async () => {
      // 场景声明在这里落到宿主的确认与计划通道上：withStandardSetup 是唯一同时持有
      // 场景元数据与 setup 包装的位置（两条通道本身由 standard-setup 负责重置）。
      await standardSetup(scene.meta.confirmPolicy, scene.meta.planPolicy)
      await sceneSetup?.()
    },
  }
}

/**
 * 失败窗口的运行期事件：只保留最近 TRACE_WINDOW_SIZE 条，按场景清空。
 *
 * 订阅点放在宿主入口而不是场景里：场景只声明「跑什么、断言什么」，
 * 「失败时给不出事件现场」是宿主观测面的缺口，该在这里补。
 * repeat>1 时一个场景的多个 trial 共用同一批事件（批内没有 trial 边界可挂钩），
 * 展开里的头部会写明「本场景共 N 条」，截断不会被读成「只发生了这么多」。
 */
let traceRecorder: ReturnType<typeof createLiveTraceRecorder> | undefined
let manifest: Record<string, unknown> = {}

async function writeManifest(complete: boolean): Promise<void> {
  manifest = { ...manifest, complete, trace: traceRecorder?.status }
  await invoke("file_write_atomic", { path: await runtimePath("data", "e2e-manifest.json"), content: JSON.stringify(manifest, null, 2) + "\n" })
}

async function finishSpecialReport(report: unknown, passed: boolean): Promise<void> {
  await traceRecorder?.complete()
  await writeManifest(true)
  await invoke("e2e_complete", { passed, report: JSON.stringify(report, null, 2) })
}

/** 读取启动器 stage 到数据根的 eval-models.json；仓库未提供（未 stage）按全部继承。 */
async function loadEvalModels(): Promise<EvalModelsFile> {
  let content: string
  try {
    content = (await invoke<{ content: string; size: number }>("file_read", { path: await runtimePath("data", "eval-models.json"), maxBytes: 64 * 1024 })).content
  } catch (error) {
    // 正常路径是「仓库文件存在 → 启动器总是 stage」；走到这里说明文件缺失或读取失败，留痕不静默。
    console.error(`[E2E] eval-models.json 未读取到，测试模型按仓库配置全部继承: ${formatError(error)}`)
    return {}
  }
  return parseEvalModelsFile(content)
}

/** 行键：trial 1 用裸 caseId（最常见的形态），repeat 时才带序号。 */
function rowKey(caseId: string, trial: number): string {
  return trial > 1 ? `${caseId}#${trial}` : caseId
}

/** 进程内唯一的进度视图引用：启动失败时 catch 出口也要能把话说进窗口。 */
let progressView: ProgressView | undefined

function makeSummary(results: TestReport["scenes"], plannedTrials: number): TestReport["summary"] {
  const caseResults = new Map<string, TestReport["scenes"]>()
  for (const result of results) {
    const list = caseResults.get(result.caseId) ?? []
    list.push(result)
    caseResults.set(result.caseId, list)
  }
  // skip 只来自「前序 trial 超时，本 trial 未执行」，既不算通过也不算失败：
  // 通过率与 pass@k / pass^k 的分母都只统计实际执行过的 trial。
  const executedByCase = [...caseResults.values()].map(trials => trials.filter(trial => trial.status !== "skip"))
  const executedCases = executedByCase.filter(trials => trials.length > 0)
  const passedCases = executedCases.filter(trials => trials.some(trial => trial.status === "pass")).length
  const passedEveryTrial = executedCases.filter(trials => trials.every(trial => trial.status === "pass")).length
  const passed = results.filter(result => result.status === "pass").length
  const skipped = results.filter(result => result.status === "skip").length
  const total = results.length
  const executedTrials = total - skipped

  return {
    total,
    passed,
    failed: results.filter(result => result.status === "fail").length,
    skipped,
    timeout: results.filter(result => result.status === "timeout").length,
    totalDuration: results.reduce((sum, result) => sum + result.duration, 0),
    totalCases: caseResults.size,
    executedCases: executedCases.length,
    totalTrials: total,
    plannedTrials,
    executedTrials,
    passRate: executedTrials === 0 ? 0 : passed / executedTrials,
    // pass@k: at least one successful trial; pass^k: every observed trial successful.
    passAtK: executedCases.length === 0 ? 0 : passedCases / executedCases.length,
    passPowerK: executedCases.length === 0 ? 0 : passedEveryTrial / executedCases.length,
  }
}

async function main(): Promise<void> {
  await initPaths()
  await initConfig()
  const raw = await invoke<RuntimeOptions>("e2e_options")
  // 测试侧统一模型配置：环境变量 > test/eval-models.json（启动器 stage 到数据根）> 继承仓库配置。
  // underTest 覆盖只作用于隔离副本（setOverrides + flushConfig），凭据与真实配置不受影响。
  const evalModels = await loadEvalModels()
  const resolvedModels = resolveEvalModels(evalModels, {
    DESKPET_EVAL_PROVIDER: raw.evalProvider,
    DESKPET_EVAL_MODEL: raw.evalModel,
    DESKPET_EVAL_JUDGE_MODEL: raw.evalJudgeModel,
  })
  if (resolvedModels.underTestProvider || resolvedModels.underTestModel) {
    setOverrides({
      ...(resolvedModels.underTestProvider ? { "ai.provider": resolvedModels.underTestProvider } : {}),
      ...(resolvedModels.underTestModel ? { "ai.model": resolvedModels.underTestModel } : {}),
    })
    await flushConfig()
  }
  const opts = parseArgs([
    ...(raw.module ? ["--module", raw.module] : []),
    ...(raw.scene ? ["--scene", raw.scene] : []),
    ...(raw.case ? ["--case", raw.case] : []),
    ...(raw.tag ? ["--tag", raw.tag] : []),
    ...(raw.suite ? ["--suite", raw.suite] : []),
    ...(raw.repeat ? ["--repeat", raw.repeat] : []),
    ...(raw.strict === "1" ? ["--strict"] : []),
    ...(raw.report ? ["--report", raw.report] : []),
    ...(raw.quality === "1" ? ["--quality"] : []),
    ...(raw.qualitySeed ? ["--quality-seed", raw.qualitySeed] : []),
    ...(raw.performance === "1" ? ["--performance"] : []),
    ...(raw.trace ? ["--trace", raw.trace] : []),
  ])

  traceRecorder = createLiveTraceRecorder(opts.trace)
  manifest = {
    schemaVersion: 1, runId: crypto.randomUUID(), timestamp: new Date().toISOString(),
    commit: raw.commit, sourceHashes: parseHashAttestation(raw.sourceHashes), seedHash: raw.seedHash,
    platform: navigator.platform, userAgent: navigator.userAgent,
    model: { provider: aiConfig.provider, model: aiConfig.model }, options: opts, expectedTrials: [],
  }
  await writeManifest(false)

  if (opts.performance) {
    manifest.expectedTrials = [{ caseId: "memory-performance", sceneId: "memory-performance", trialId: "1" }]
    await writeManifest(false)
    await traceRecorder.beginTrial("memory-performance", "1")
    const report = await runMemoryPerformanceEvaluation(opts.trace, traceRecorder.bindOperation)
    await traceRecorder.endTrial("memory-performance", "1")
    await finishSpecialReport({ ...report, runEvidence: {commit: manifest.commit, sourceHashes: manifest.sourceHashes,
      seedHash: manifest.seedHash, model: manifest.model} }, report.passed)
    return
  }

  if (opts.quality) {
    const qualityLog = createLogger("MemoryQuality") // Long-run progress also reaches the isolated host's terminal log.
    const trials = Math.max(3, opts.repeat)
    const filter = opts.caseId ? [opts.caseId] : undefined
    const cases = filter ? MEMORY_QUALITY_CASES.filter(item => filter.includes(item.caseId) || filter.includes(item.group)) : MEMORY_QUALITY_CASES
    manifest.expectedTrials = cases.flatMap(item => Array.from({ length: trials }, (_, index) => ["extraction", ...MEMORY_QUALITY_STRATEGIES].map(strategy => ({ caseId: item.caseId, sceneId: `${item.caseId}/${strategy}`, trialId: String(index + 1) }))).flat())
    await writeManifest(false)
    const report = await runMemoryQualityEvaluation({
      adapter: createLiveMemoryQualityAdapter(), seed: opts.qualitySeed, trials, caseFilter: filter,
      onCellStart: async (cell: MemoryQualityCellContext) => {
        const sceneId = `${cell.caseId}/${cell.strategy}`
        await traceRecorder!.beginTrial(sceneId, String(cell.trial))
        qualityLog.info(`${cell.sequence}/${cell.total} ${cell.caseId} ${cell.strategy} trial=${cell.trial}`)
      },
      onCellEnd: async cell => {
        // Each finished cell survives a later timeout; the summary cannot erase partial outcomes.
        await invoke("file_append", { path: await runtimePath("data", "memory-quality-outcomes.jsonl"), content: JSON.stringify(cell) + "\n", maxBytes: 5 * 1024 * 1024 })
        await traceRecorder!.endTrial(`${cell.caseId}/${cell.strategy}`, String(cell.trial))
      },
    })
    manifest.quality = { datasetVersion: report.datasetVersion, evalRunId: report.evalRunId, manifest: report.manifest }
    // Collection success is not a semantic pass; the independent review command owns that gate.
    // 这里只 AND 采集路径推不出的两项（双人 gold 审计与裁决完成）：qualityThresholdsPassed
    // 自身已包含 complete / governanceZero / 各能力阈值（见 runMemoryQualityEvaluation 的 allQualityGates），
    // 再逐项重列属于防御性冗余，曾经的阈值重列是重复定义点，已收敛。
    const qualityPassed = report.gates.qualityThresholdsPassed === true && report.gates.goldAuditComplete === true && report.gates.reviewComplete === true
    await finishSpecialReport({ ...report, runEvidence: {commit: manifest.commit, sourceHashes: manifest.sourceHashes, seedHash: manifest.seedHash}, status: qualityPassed ? "pass" : report.gates.complete && report.gates.governanceZero ? "pending_review" : "fail" }, qualityPassed)
    return
  }

  if (raw.bench === "1") {
    const benchLog = createLogger("MemoryBench") // Long-run progress also reaches the isolated host's terminal log.
    const dataset = raw.benchDataset
    if (!dataset) {
      await finishSpecialReport({ error: "缺少 --bench-dataset（longmemeval / locomo / memorybank）" }, false)
      return
    }
    const info = benchSplitInfo(dataset, raw.benchSplit)
    // 数据由启动器从开发者 data-dir（DESKPET_BENCH_DATA_DIR / --data-dir）stage 成
    // 隔离数据根的 bench/cases.json；宿主只读固定路径，不做运行期下载。
    const benchPath = await runtimePath("data", "bench", "cases.json")
    const loaded = await invoke<{ content: string; size: number }>("file_read", { path: benchPath, maxBytes: 64 * 1024 * 1024 })
    const file = JSON.parse(loaded.content) as BenchCaseFile
    const seed = raw.benchSeed ?? "memory-bench-2026-10-03"
    // Rust 的 Option<String> 缺失时序列化为 null（不是 undefined），一律按 nullish 处理。
    const limit = raw.benchLimit ? Number.parseInt(raw.benchLimit, 10) : undefined
    if (raw.benchLimit && (!Number.isInteger(limit) || (limit ?? 0) <= 0))
      throw new Error(`--bench-limit 必须是正整数: ${raw.benchLimit}`)
    const caseFilter = raw.benchCase ? raw.benchCase.split(",").map(value => value.trim()).filter(Boolean) : undefined
    const judgeMode = raw.benchJudge === "off" ? "off" : "on"
    const judgeModel = raw.benchJudgeModel ?? resolvedModels.judgeModel ?? "deepseek-reasoner"
    const planned = planBenchCells(dataset, file, { limit, caseFilter, seed })
    manifest.bench = { dataset, split: info.split, namespace: info.namespace, plannedCells: planned.length,
      seed, judge: judgeMode === "off" ? null : judgeModel }
    manifest.expectedTrials = planned.map(cell => ({ caseId: cell.caseId, sceneId: cell.caseId, trialId: "1" }))
    await writeManifest(false)
    const report: BenchReport = await runMemoryBenchEvaluation({
      adapter: createLiveMemoryBenchAdapter(),
      dataset, split: info.split, file, seed, limit, caseFilter, judge: judgeMode, judgeModel,
      onCellStart: async (cell: BenchCellContext) => {
        await traceRecorder!.beginTrial(cell.caseId, "1")
        benchLog.info(`${cell.sequence}/${cell.total} ${cell.caseId}`)
      },
      onCellEnd: async cell => {
        // 每题一行落盘：LongMemEval 行内同时携带官方 evaluate_qa.py 所需的 question_id/hypothesis，
        // 失败中止也不会丢掉已完成的题；官方脚本可直接消费该 JSONL（多余字段会被忽略）。
        const outcome = cell.outcome as { answer?: string } | undefined
        const line = { caseId: cell.caseId, questionId: cell.questionId ?? null, status: cell.status,
          hypothesis: outcome?.answer ?? null, judgment: cell.judgment ?? null, outcome: cell.outcome ?? null,
          error: cell.error ?? null }
        await invoke("file_append", { path: await runtimePath("data", "memory-bench-outcomes.jsonl"),
          content: JSON.stringify(line) + "\n", maxBytes: 5 * 1024 * 1024 })
        await writeManifest(false)
        await traceRecorder!.endTrial(cell.caseId, "1")
      },
    })
    manifest.bench = { ...(manifest.bench as Record<string, unknown>), evalRunId: report.evalRunId,
      judgeModel: report.judgeModel, upstream: report.upstream, importTransformVersion: report.importTransformVersion }
    // 外部基准是观测证据：passed 只表示「完整跑完」，质量阈值字段在报告中恒为 null。
    const benchPassed = report.gates.complete === true
    await finishSpecialReport({ ...report, runEvidence: { commit: manifest.commit,
      sourceHashes: manifest.sourceHashes, seedHash: manifest.seedHash } }, benchPassed)
    return
  }

  const contracts = collectContracts()
  const allScenes = collectScenes()
  const contractResults = checkAllContracts(contracts, allScenes, parseHashAttestation(raw.sourceHashes))
  for (const result of contractResults) {
    if (result.stale) console.warn(`[STALE] ${result.module}: ${result.staleReason ?? "sourceHash 未确认"}`)
    for (const missing of result.missing) console.warn(`[MISSING] ${result.module}/${missing}: ${missing}`)
    for (const gap of result.gaps) console.error(gap)
  }

  let scenes = allScenes
  if (opts.module) scenes = scenes.filter(scene => scene.meta.module === opts.module)
  if (opts.scene) scenes = scenes.filter(scene => scene.meta.description.includes(opts.scene!))
  if (opts.caseId) scenes = scenes.filter(scene => scene.meta.caseId === opts.caseId)
  if (opts.tag) scenes = scenes.filter(scene => scene.meta.tags?.includes(opts.tag!))
  if (opts.suite) scenes = scenes.filter(scene => scene.meta.suite === opts.suite)

  const prepared = scenes.map(withStandardSetup)
  const totalTrials = plannedTrialCount(prepared, opts.repeat)
  manifest.expectedTrials = prepared.flatMap(scene => Array.from({ length: plannedTrialCount([scene], opts.repeat) }, (_, index) => ({ caseId: scene.meta.caseId, sceneId: scene.meta.caseId, trialId: String(index + 1) })))
  await writeManifest(false)

  // 视图在任何场景跑之前建好：数据集/契约失败、启动崩溃也要能一眼看见，
  // 而不是留下一扇从加载到结束都不动的白窗口。
  const progressRoot = document.getElementById("e2e-progress")
  if (!progressRoot) {
    // 观测面是装饰，坏了不拖垮测试协议（结果照旧走 console 与 e2e_complete）；
    // 根因留痕在 reportError（统一出口），不在这里变成静默。
    reportError("e2e", new Error("test-e2e.html 缺少 #e2e-progress 容器，窗口进度不可见"), { kind: "观测面配置" })
  }
  progressView = createProgressView(progressRoot ?? document.body, totalTrials, {
    // Rust 侧的固定结果文件：窗口在进程退出前能给出的唯一权威绝对路径。
    // 退出后由启动器留存到报告目录（最终路径启动器打印在终端）。
    reportPath: await runtimePath("data", "e2e-result.txt"),
    reportDir: await runtimePath("data"),
    openDirectory: dirPath => {
      void invoke("app_open", { path: dirPath }).catch(error => {
        reportError("e2e", error, { kind: "打开报告目录失败" })
      })
    },
  })

  const datasetErrors = validateDataset(allScenes, contracts)
  const selectedContracts = opts.module
    ? contractResults.filter(result => result.module === opts.module)
    : contractResults
  const strictContractFailure = opts.strictContracts && selectedContracts.some(result => !result.valid)
  const reportBase = {
    schemaVersion: "desk-pet-live/v2" as const,
    datasetVersion: LIVE_DATASET_VERSION,
    runId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    options: opts,
    environment: {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      seedHash: raw.seedHash,
      commit: raw.commit,
    },
    datasetErrors,
    contracts: selectedContracts,
  }

  if (datasetErrors.length > 0 || strictContractFailure) {
    const report: TestReport = { ...reportBase, scenes: [], summary: makeSummary([], 0) }
    const formatted = formatReport(report, opts.report)
    console.error(formatted)
    progressView.finish({
      passed: false,
      note: `未运行任何场景：数据集错误 ${datasetErrors.length} 条${strictContractFailure ? "，契约校验不通过" : ""}`,
    })
    await traceRecorder.complete()
    await writeManifest(true)
    await invoke("e2e_complete", { passed: false, report: formatted })
    return
  }

  const results: TestReport["scenes"] = []
  for (const scene of prepared) {
    // 一个场景的全部 trial 都先摆成 pending：剩余量是看得见的，而不是跑完才有的数。
    const trialCount = plannedTrialCount([scene], opts.repeat)
    for (let trial = 1; trial <= trialCount; trial++) {
      progressView.plan(rowKey(scene.meta.caseId, trial), scene.meta.caseId, scene.meta.description)
    }
    // 一次只喂一个场景给 runAllScenes：超时后跳过同场景剩余 trial 的策略在它内部，
    // 拆批不改语义（批之间没有共享状态），换来的是一跑完就能逐条结算。
    // 批内没有逐 trial 回调，所以进行中标记只能落在这个场景最早未结算的行上；
    // repeat>1 时它可能落后于真实回合，状态与耗时不受影响。
    progressView.start(rowKey(scene.meta.caseId, 1), scene.meta.caseId, scene.meta.description)
    const sceneResults = await runAllScenes([scene], opts.repeat, {
      onTrialStart: async (current, trial) => { await traceRecorder!.beginTrial(current.meta.caseId, String(trial)) },
      onTrialEnd: async result => { await traceRecorder!.endTrial(result.caseId, String(result.trial)) },
    })
    for (const result of sceneResults) {
      const key = rowKey(result.caseId, result.trial)
      if (result.status === "skip") {
        progressView.skip(key, result.error ?? "未执行")
        continue
      }
      if (result.status === "pass") {
        // 通过但含声明并命中的预期失败：单独一档，别让它看起来什么都没发生。
        if (result.turns.some(turn => turn.expectedFailure)) progressView.expectedFailure(key, result.duration)
        else progressView.pass(key, result.duration)
        continue
      }
      // 失败行立即展开的内容：断言差异 + 失败窗口的事件序列（契约「观测面」目标 1）。
      progressView.fail(key, result.duration, [
        ...formatSceneFailure(result),
        ...formatTraceEvents(traceRecorder.recent.slice(-TRACE_WINDOW_SIZE), traceRecorder.status.recorded),
      ])
    }
    results.push(...sceneResults)
  }

  const report: TestReport = { ...reportBase, scenes: results, summary: makeSummary(results, totalTrials) }
  const formatted = formatReport(report, opts.report)
  console.log(formatted)
  await traceRecorder.complete()
  await writeManifest(true)
  const passed = report.summary.failed === 0
    && report.summary.timeout === 0
    && report.summary.total > 0
    && report.summary.skipped === 0
    && report.datasetErrors.length === 0
    && (!opts.strictContracts || report.contracts.every(contract => contract.valid))
  progressView.finish({
    passed,
    note: passed
      ? undefined
      : [
        // 一条都没跑（选择条件没命中）与「跑了但有失败」是两种不同的结论，窗口要分开说。
        results.length === 0 ? "没有任何场景被执行：检查 --module / --case / --tag / --suite 选择条件" : "",
        `失败 ${report.summary.failed} · 超时 ${report.summary.timeout} · 跳过 ${report.summary.skipped}`,
      ].filter(Boolean).join("；"),
  })
  await invoke("e2e_complete", { passed, report: formatted })
}

// 测试报告本身走 console（见上方 formatReport），这里只补「未捕获异常也要有出口」。
// overlay: false —— 独立测试窗口不需要弹覆盖层，日志与报告已足够。
installGlobalHandlers("e2e", { overlay: false })

main().catch(async error => {
  const message = error instanceof Error ? error.stack || error.message : String(error)
  reportError("e2e", error, { kind: "启动或执行失败" })
  // 窗口里也要留结论：崩溃不能只表现为「跑到一半不动了」。
  progressView?.finish({ passed: false, note: `启动或执行失败：${formatError(error)}` })
  try {
    await traceRecorder?.complete()
    await writeManifest(false)
  } catch (traceError) {
    reportError("e2e", traceError, { kind: "失败现场落盘失败" })
  }
  try { await invoke("e2e_complete", { passed: false, report: message }) } catch (completionError) {
    reportError("e2e", completionError, { kind: "失败结果落盘失败" })
  }
})
