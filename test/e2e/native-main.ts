// ==========================================
// L4 Node 宿主入口（test/e2e Scene runner，运行在唯一 Node 内）
// ==========================================
//
// 执行契约 §8 W11：场景 runner 从「Tauri WebView 里的页面」变成「Node 内的一段代码」。
//
// - 进程由原生宿主的监督器拉起（入口 = 本文件的 Vite SSR 单文件 bundle；构建见
//   test/host/native/build.mjs），连接经私有 IPC（connectHostBridge），不经过 DOM。
// - Scene/Contract/caseId/sourceHash 语义与三入口（executeTurn 的 unit / production /
//   runtime）原样保留：本文件只替换宿主环境（DOM 观测面 → 终端；invoke → HostBridge）。
// - fake 只替换 Provider；production 入口仍走 `sendMessage()`，工具与 IPC 照真执行
//   （由具体场景的断言证明）。
// - 完成协议：结果经 `e2e_complete` 交宿主落盘（e2e-result.txt），随后等宿主关停序列；
//   宿主以退出码承载结论。启动器按「结果文件 + 退出码」判定（`judgeNativeVerdict`）。
// - 测试命令面（e2e_options / e2e_complete / e2e_trace）只在 debug + is_e2e 的宿主里
//   存在；release 产品能力不含它们。
//
// 开发工具直接用 console（终端进度与失败现场）：把它接进产品日志链会在启动失败时
// 制造循环依赖 [保留已登记 §4.2]。

import { appendFileSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { connectHostBridge, setHostBridge } from "@/services/host"
import type { FlushReport, HostBridgeRuntime, HostCommandMap } from "@/services/host"
import { initPaths } from "@/services/paths"
import { aiConfig, flushConfig, initConfig, setOverrides } from "@/services/config"
import { reportError, formatError } from "@/services/error"
import { createLogger } from "@/services/logger"

import { LIVE_DATASET_VERSION, validateDataset } from "./dataset"
import { plannedTrialCount, runAllScenes } from "./scene-runner"
import { formatReport } from "./reporter"
import { createConsoleProgressView, createConsoleSpecialView } from "./console-progress"
import { checkAllContracts } from "../host/contract-checker"
import { standardSetup } from "../host/standard-setup"
import { createLiveTraceRecorder } from "../host/trace-observer"
import { parseArgs } from "./cli"
import { parseEvalModelsFile, resolveEvalModels } from "./eval-models"
import { runMemoryPerformanceEvaluation } from "./memory-performance"
import { createLiveMemoryQualityAdapter } from "../memory-quality/live-adapter"
import { MEMORY_QUALITY_CASES, MEMORY_QUALITY_STRATEGIES, runMemoryQualityEvaluation } from "../memory-quality/index.mjs"
import { createLiveMemoryBenchAdapter } from "../memory-bench/bench-adapter"
import { installUiEventTap } from "../host/ui-event-tap"
import { benchSplitInfo, planBenchCells, runMemoryBenchEvaluation } from "../memory-bench/index.mjs"
import { TRACE_WINDOW_SIZE, formatSceneFailure, formatTraceEvents } from "./progress"

import type { EvalModelsFile } from "./eval-models"
import type { MemoryQualityCellContext } from "../memory-quality/live-adapter"
import type { BenchCaseFile, BenchCellContext, BenchReport } from "../memory-bench/index.mjs"
import type { ModuleContract } from "../host/types"
import type { ProgressView } from "./progress"
import type { SceneDef, TestReport } from "./types"

/** HostCommandMap 的 e2e_options 投影 + 通道身份（trialId 是测试通道字段，不是产品命令字段）。 */
type E2eOptionsPayload = HostCommandMap["e2e_options"]["result"] & { trialId?: string | null }

export interface NativeLiveHostInput {
  /** 场景模块命名空间（构建时由 test/host/native/build.mjs 扫描 scenes/ 生成，替代 import.meta.glob）。 */
  sceneModules: Record<string, unknown>[]
  /** 契约模块命名空间（扫描 test/contracts/ 生成）。 */
  contractModules: Record<string, unknown>[]
}

// ── 进程内唯一运行态（一次运行一个进程；与旧 WebView 入口的模块级状态同构）──

let traceRecorder: ReturnType<typeof createLiveTraceRecorder> | undefined
let traceCompleted = false
let manifest: Record<string, unknown> = {}
let dataRoot = ""

/**
 * Node 宿主入口。由生成的 entry 模块 import 并调用 —— 不经顶层 await（单文件内联
 * 动态导入的 bundle 禁顶层 await，见 test/host/native/build.mjs 的构建期守卫）；
 * 返回后进程仍由 IPC 事件循环维持，直到宿主执行关停序列（shutdown → flush 报告 →
 * 连接断开）。
 */
export async function runNativeLiveHost(input: NativeLiveHostInput): Promise<void> {
  let bridge: HostBridgeRuntime
  try {
    bridge = await connectHostBridge()
  } catch (error) {
    // 宿主连接都建立不了：没有结果通道可交付 —— 宿主按「完成前退出」以非零码结束，
    // 启动器按「未生成结果文件」判失败。
    console.error(`[E2E] 连接原生宿主失败：${formatError(error)}`)
    process.exit(70)
  }
  setHostBridge(bridge)
  installUiEventTap()
  installProcessErrorHooks()

  let finished = false
  let resolveShutdown: (() => void) | undefined
  const shutdownDone = new Promise<void>(resolve => { resolveShutdown = resolve })
  bridge.onShutdown(async (): Promise<FlushReport> => ({
    // 真实报告：trace 完整 ACK 才算 flush 完成；未完成时宿主如实记中断。
    flushed: traceCompleted,
    pending: traceCompleted ? 0 : 1,
    detail: traceCompleted
      ? "E2E runner：trace 已完整 ACK，结果已交宿主落盘"
      : "E2E runner：运行未收尾或 trace 未完成",
  }))
  bridge.onDisconnect(() => { resolveShutdown?.() })

  try {
    await main(bridge, input)
    finished = true
  } catch (error) {
    await failFast(bridge, error)
  }
  // 结果已落盘：等宿主走完关停序列（发 shutdown、收 flush 报告、关闭连接）。
  // 有界等待，宿主异常时不把进程永久挂住。
  await Promise.race([shutdownDone, delay(10_000)])
  process.exit(finished ? 0 : 1)
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Node 侧未捕获异常出口（旧 WebView 入口装的是 window 拦截器）。
 * 统一错误出口（@/services/error）仍是唯一代理；报告走 console 与 e2e_complete。
 */
function installProcessErrorHooks(): void {
  process.on("uncaughtException", error => {
    reportError("e2e", error, { kind: "uncaughtException" })
  })
  process.on("unhandledRejection", reason => {
    reportError("e2e", reason, { kind: "unhandledRejection" })
  })
}

function resultFilePath(): string {
  return join(dataRoot, "e2e-result.txt")
}

/** 失败路径：尽力保住现场（trace / manifest / 失败结果），不遮蔽首个错误。 */
async function failFast(bridge: HostBridgeRuntime, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  reportError("e2e", error, { kind: "启动或执行失败" })
  console.error(`[E2E] 启动或执行失败：${message}`)
  try {
    await traceRecorder?.complete()
    traceCompleted = true
  } catch (traceError) {
    reportError("e2e", traceError, { kind: "失败现场落盘失败" })
  }
  try {
    if (dataRoot) await writeManifest(false)
  } catch (manifestError) {
    reportError("e2e", manifestError, { kind: "失败现场 manifest 落盘失败" })
  }
  try {
    await bridge.request("e2e_complete", { passed: false, report: message })
  } catch (completionError) {
    reportError("e2e", completionError, { kind: "失败结果落盘失败" })
  }
}

function parseHashAttestation(raw?: string): Record<string, string> | undefined {
  // 形状不对（或没值）就当作「没有证明」，由 contract-checker 判 stale —— 猜错的方向是假通过。
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const entries = Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    return entries.length > 0 ? Object.fromEntries(entries) : undefined
  } catch {
    return undefined
  }
}

function collectScenes(modules: Record<string, unknown>[]): SceneDef[] {
  // 与旧入口同一语义：只按对象身份收敛 export 别名，不按 caseId 收敛
  // （重复 caseId 由 validateDataset 负责报错）。
  const scenes = modules
    .flatMap(module => Object.values(module))
    .filter((scene): scene is SceneDef => Boolean(scene && typeof scene === "object" && "meta" in scene && scene.meta))
  return [...new Set(scenes)]
}

function collectContracts(modules: Record<string, unknown>[]): ModuleContract[] {
  const contracts = modules
    .flatMap(module => Object.values(module))
    .filter((contract): contract is ModuleContract => {
      const candidate = contract as Partial<ModuleContract> | null | undefined
      return Boolean(candidate && candidate.module && candidate.coverage)
    })
  return [...new Map(contracts.map(contract => [contract.module, contract])).values()]
}

function withStandardSetup(scene: SceneDef): SceneDef {
  const sceneSetup = scene.setup
  return {
    ...scene,
    setup: async () => {
      // 场景声明在这里落到宿主的确认与计划通道上（唯一同时持有场景元数据与 setup 的位置）。
      await standardSetup(scene.meta.confirmPolicy, scene.meta.planPolicy)
      await sceneSetup?.()
    },
  }
}

function rowKey(caseId: string, trial: number): string {
  return trial > 1 ? `${caseId}#${trial}` : caseId
}

function makeSummary(results: TestReport["scenes"], plannedTrials: number): TestReport["summary"] {
  const caseResults = new Map<string, TestReport["scenes"]>()
  for (const result of results) {
    const list = caseResults.get(result.caseId) ?? []
    list.push(result)
    caseResults.set(result.caseId, list)
  }
  // skip 只来自「前序 trial 超时，本 trial 未执行」：通过率与 pass@k / pass^k 的分母
  // 只统计实际执行过的 trial（与旧入口同一口径）。
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
    passAtK: executedCases.length === 0 ? 0 : passedCases / executedCases.length,
    passPowerK: executedCases.length === 0 ? 0 : passedEveryTrial / executedCases.length,
  }
}

/**
 * manifest 原子写（临时文件 + rename，与旧路径的 file_write_atomic 同语义；
 * Node 直写是宿主测试驱动的本分，不绕过任何产品写路径）。
 */
function writeManifestSync(complete: boolean): void {
  if (!dataRoot) throw new Error("manifest 早于路径初始化")
  manifest = { ...manifest, complete, trace: traceRecorder?.status }
  const target = join(dataRoot, "e2e-manifest.json")
  const temp = `${target}.tmp`
  writeFileSync(temp, JSON.stringify(manifest, null, 2) + "\n")
  renameSync(temp, target)
}

async function writeManifest(complete: boolean): Promise<void> {
  writeManifestSync(complete)
}

/** 读取启动器 stage 到隔离根的文本文件；缺失返回 undefined（调用方决定口径）。 */
function readStagedText(relativeName: string): string | undefined {
  try {
    return readFileSync(join(dataRoot, relativeName), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

/** 读取启动器 stage 的必需输入（缺失/超限是基础设施失败，不静默）。 */
function readRequiredText(relativeName: string, maxBytes: number): string {
  const file = join(dataRoot, relativeName)
  const size = statSync(file).size
  if (size > maxBytes) throw new Error(`${relativeName} 超过 ${maxBytes} bytes 上限（实际 ${size}）`)
  return readFileSync(file, "utf8")
}

/** 逐行追加（旧 file_append 语义：maxBytes 限制的是本次追加内容，不是文件总量）。 */
function appendJsonl(fileName: string, payload: unknown, maxBytes = 5 * 1024 * 1024): void {
  const content = JSON.stringify(payload) + "\n"
  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    throw new Error(`${fileName} 单次追加内容超过 ${maxBytes} bytes`)
  }
  appendFileSync(join(dataRoot, fileName), content)
}

/** 读取两层测试侧模型配置（进 git 的基线 + 本地凭据覆盖；优先级链与旧入口一致）。 */
function loadEvalModels(): { base: EvalModelsFile; local: EvalModelsFile } {
  const baseText = readStagedText("eval-models.json")
  if (baseText === undefined) {
    // 正常路径是「仓库文件存在 → 启动器总是 stage」；缺失说明没走启动脚本，留痕不静默。
    console.error("[E2E] eval-models.json 未读取到，测试模型按隔离副本配置全部继承")
  }
  const localText = readStagedText("eval-models.local.json")
  return {
    base: baseText === undefined ? {} : parseEvalModelsFile(baseText, { allowCredentials: false }),
    local: localText === undefined ? {} : parseEvalModelsFile(localText, { allowCredentials: true }),
  }
}

async function finishSpecialReport(bridge: HostBridgeRuntime, report: unknown, passed: boolean): Promise<void> {
  await traceRecorder?.complete()
  traceCompleted = true
  await writeManifest(true)
  await bridge.request("e2e_complete", { passed, report: JSON.stringify(report, null, 2) })
}

/** 长跑 cell 状态 → 视图三态：完整通过 / 未裁决（跳过）/ 失败。 */
function cellStatusForView(status: string): "pass" | "fail" | "skip" {
  if (status === "complete") return "pass"
  if (status === "inconclusive") return "skip"
  return "fail"
}

async function main(bridge: HostBridgeRuntime, input: NativeLiveHostInput): Promise<void> {
  await initPaths()
  await initConfig()
  const raw = (await bridge.request("e2e_options", {})) as E2eOptionsPayload
  dataRoot = (await bridge.request("get_runtime_paths", {})).data

  // 测试侧统一模型配置：通道选项（原环境变量）> test/eval-models.local.json（本地专属）
  // > test/eval-models.json（启动器 stage 到隔离根）> 继承隔离副本配置。
  // underTest 覆盖只作用于隔离副本（setOverrides + flushConfig），凭据与真实配置不受影响。
  const evalModels = loadEvalModels()
  const resolvedModels = resolveEvalModels(evalModels.base, evalModels.local, {
    DESKPET_EVAL_PROVIDER: raw.evalProvider ?? undefined,
    DESKPET_EVAL_MODEL: raw.evalModel ?? undefined,
    DESKPET_EVAL_JUDGE_MODEL: raw.evalJudgeModel ?? undefined,
  })
  if (resolvedModels.underTestProvider || resolvedModels.underTestModel || resolvedModels.underTestEndpoint || resolvedModels.underTestApiKey || resolvedModels.underTestReviewMaxTokens !== undefined) {
    setOverrides({
      ...(resolvedModels.underTestProvider ? { "ai.provider": resolvedModels.underTestProvider } : {}),
      ...(resolvedModels.underTestModel ? { "ai.model": resolvedModels.underTestModel } : {}),
      ...(resolvedModels.underTestEndpoint ? { "ai.endpoint": resolvedModels.underTestEndpoint } : {}),
      ...(resolvedModels.underTestApiKey ? { "ai.apiKey": resolvedModels.underTestApiKey } : {}),
      ...(resolvedModels.underTestReviewMaxTokens !== undefined ? { "ai.memory.dreaming.reviewMaxTokens": resolvedModels.underTestReviewMaxTokens } : {}),
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
    schemaVersion: 1,
    runId: crypto.randomUUID(),
    // trial 身份来自私有测试通道（启动器生成）：结果/日志/报告绑定同一场运行。
    trialId: raw.trialId ?? null,
    timestamp: new Date().toISOString(),
    commit: raw.commit,
    sourceHashes: parseHashAttestation(raw.sourceHashes ?? undefined),
    seedHash: raw.seedHash,
    platform: process.platform,
    userAgent: `node ${process.version}`,
    model: { provider: aiConfig.provider, model: aiConfig.model },
    options: opts,
    expectedTrials: [],
  }
  await writeManifest(false)

  // ── 特殊模式（记忆性能 / 记忆质量 / 外部基准）：与旧入口同一编排，只是观测面换成终端 ──

  if (opts.performance) {
    manifest.expectedTrials = [{ caseId: "memory-performance", sceneId: "memory-performance", trialId: "1" }]
    await writeManifest(false)
    const view = createConsoleSpecialView({ mode: "记忆性能评测", total: 1, reportPath: resultFilePath() })
    view.begin({ key: "memory-performance", label: "memory-performance" })
    await traceRecorder.beginTrial("memory-performance", "1")
    const report = await runMemoryPerformanceEvaluation(opts.trace, traceRecorder.bindOperation)
    await traceRecorder.endTrial("memory-performance", "1")
    view.end({ key: "memory-performance", status: report.passed ? "pass" : "fail", note: report.passed ? "通过" : "未达标" })
    view.finish({ verdict: report.passed ? "pass" : "fail", note: report.passed ? "性能门槛通过" : "性能门槛未通过，见报告明细" })
    await finishSpecialReport(bridge, {
      ...report,
      runEvidence: { commit: manifest.commit, sourceHashes: manifest.sourceHashes, seedHash: manifest.seedHash, model: manifest.model },
    }, report.passed)
    return
  }

  if (opts.quality) {
    const qualityLog = createLogger("MemoryQuality")
    const trials = Math.max(3, opts.repeat)
    const filter = opts.caseId ? [opts.caseId] : undefined
    const cases = filter ? MEMORY_QUALITY_CASES.filter(item => filter.includes(item.caseId) || filter.includes(item.group)) : MEMORY_QUALITY_CASES
    manifest.expectedTrials = cases
      .flatMap(item => Array.from({ length: trials }, (_, index) => ["extraction", ...MEMORY_QUALITY_STRATEGIES].map(strategy => ({ caseId: item.caseId, sceneId: `${item.caseId}/${strategy}`, trialId: String(index + 1) })))
      .flat())
    await writeManifest(false)
    const view = createConsoleSpecialView({ mode: `记忆质量采集 · ${cases.length} 题 × ${trials} trial`, total: cases.length * trials * (1 + MEMORY_QUALITY_STRATEGIES.length), reportPath: resultFilePath() })
    const cellKey = (cell: MemoryQualityCellContext): string => `${cell.caseId}/${cell.strategy}@${cell.trial}`
    const report = await runMemoryQualityEvaluation({
      adapter: createLiveMemoryQualityAdapter(),
      seed: opts.qualitySeed,
      trials,
      caseFilter: filter,
      onCellStart: async (cell: MemoryQualityCellContext) => {
        await traceRecorder!.beginTrial(`${cell.caseId}/${cell.strategy}`, String(cell.trial))
        qualityLog.info(`${cell.sequence}/${cell.total} ${cell.caseId} ${cell.strategy} trial=${cell.trial}`)
        view.begin({ key: cellKey(cell), label: `${cell.sequence}/${cell.total} ${cell.caseId} ${cell.strategy} t${cell.trial}` })
      },
      onCellEnd: async cell => {
        // Each finished cell survives a later timeout; the summary cannot erase partial outcomes.
        appendJsonl("memory-quality-outcomes.jsonl", cell)
        await traceRecorder!.endTrial(`${cell.caseId}/${cell.strategy}`, String(cell.trial))
        view.end({ key: cellKey(cell), status: cellStatusForView(cell.status), note: cell.status })
      },
    })
    manifest.quality = { datasetVersion: report.datasetVersion, evalRunId: report.evalRunId, manifest: report.manifest }
    // Collection success is not a semantic pass; the independent review command owns that gate.
    const qualityPassed = report.gates.qualityThresholdsPassed === true && report.gates.goldAuditComplete === true && report.gates.reviewComplete === true
    view.finish({
      verdict: qualityPassed ? "pass" : report.gates.complete && report.gates.governanceZero ? "pending" : "fail",
      note: `完成 ${report.completedCells}/${report.plannedCells} · 失败 ${report.failures.length}`
        + (qualityPassed ? "" : " · 采集成功不等于质量通过：还需双人 gold 审计与独立审阅"),
    })
    await finishSpecialReport(bridge, {
      ...report,
      runEvidence: { commit: manifest.commit, sourceHashes: manifest.sourceHashes, seedHash: manifest.seedHash },
      status: qualityPassed ? "pass" : report.gates.complete && report.gates.governanceZero ? "pending_review" : "fail",
    }, qualityPassed)
    return
  }

  if (raw.bench === "1") {
    const benchLog = createLogger("MemoryBench")
    const dataset = raw.benchDataset
    if (!dataset) {
      await finishSpecialReport(bridge, { error: "缺少 --bench-dataset（longmemeval / locomo / memorybank）" }, false)
      return
    }
    const info = benchSplitInfo(dataset, raw.benchSplit ?? undefined)
    // 数据由启动器从开发者 data-dir stage 成隔离数据根的 bench/cases.json；宿主只读固定路径。
    const file = JSON.parse(readRequiredText(join("bench", "cases.json"), 64 * 1024 * 1024)) as BenchCaseFile
    const seed = raw.benchSeed ?? "memory-bench-2026-10-03"
    const limit = raw.benchLimit ? Number.parseInt(raw.benchLimit, 10) : undefined
    if (raw.benchLimit && (!Number.isInteger(limit) || (limit ?? 0) <= 0)) {
      throw new Error(`--bench-limit 必须是正整数: ${raw.benchLimit}`)
    }
    const caseFilter = raw.benchCase ? raw.benchCase.split(",").map(value => value.trim()).filter(Boolean) : undefined
    const judgeMode = raw.benchJudge === "off" ? "off" : "on"
    const judgeModel = raw.benchJudgeModel ?? resolvedModels.judgeModel ?? "deepseek-reasoner"
    const readerControlValue = raw.benchReaderControl ?? undefined
    if (readerControlValue && (dataset !== "longmemeval" || info.split !== "oracle" || !["direct", "con"].includes(readerControlValue))) {
      throw new Error("--bench-reader-control 仅支持 longmemeval oracle 的 direct|con")
    }
    const readerControl = readerControlValue as "direct" | "con" | undefined
    const planned = planBenchCells(dataset, file, { limit, caseFilter, seed })
    manifest.bench = {
      dataset, split: info.split, namespace: info.namespace, plannedCells: planned.length,
      seed, judge: judgeMode === "off" ? null : judgeModel, readerControl: readerControl ?? null,
    }
    manifest.expectedTrials = planned.map(cell => ({ caseId: cell.caseId, sceneId: cell.caseId, trialId: "1" }))
    await writeManifest(false)
    const view = createConsoleSpecialView({ mode: `外部记忆基准 · ${dataset}/${info.split}`, total: planned.length, reportPath: resultFilePath() })
    const report: BenchReport = await runMemoryBenchEvaluation({
      adapter: createLiveMemoryBenchAdapter({ readerControl }),
      dataset, split: info.split, file, seed, limit, caseFilter, judge: judgeMode, judgeModel,
      onCellStart: async (cell: BenchCellContext) => {
        await traceRecorder!.beginTrial(cell.caseId, "1")
        benchLog.info(`${cell.sequence}/${cell.total} ${cell.caseId}`)
        view.begin({ key: cell.caseId, label: `${cell.sequence}/${cell.total} ${cell.caseId}` })
      },
      onCellEnd: async cell => {
        // 每题一行落盘：失败中止也不会丢掉已完成的题；官方脚本可直接消费该 JSONL。
        const outcome = cell.outcome as { answer?: string } | undefined
        appendJsonl("memory-bench-outcomes.jsonl", {
          caseId: cell.caseId,
          questionId: cell.questionId ?? null,
          status: cell.status,
          hypothesis: outcome?.answer ?? null,
          judgment: cell.judgment ?? null,
          outcome: cell.outcome ?? null,
          error: cell.error ?? null,
        })
        await writeManifest(false)
        await traceRecorder!.endTrial(cell.caseId, "1")
        view.end({ key: cell.caseId, status: cellStatusForView(cell.status), note: cell.status })
      },
    })
    manifest.bench = {
      ...(manifest.bench as Record<string, unknown>),
      evalRunId: report.evalRunId,
      judgeModel: report.judgeModel,
      upstream: report.upstream,
      importTransformVersion: report.importTransformVersion,
    }
    // 外部基准是观测证据：passed 只表示「完整跑完」，质量阈值字段在报告中恒为 null。
    const benchPassed = report.gates.complete === true
    const scores = report.scores as {
      overall?: { correct?: number; judged?: number; accuracy?: number | null }
      accuracy?: { correct?: number; judged?: number; value?: number | null }
      meanScore?: number | null
      scored?: number
    }
    const benchAccuracy = scores.overall ? scores.overall.accuracy : scores.accuracy?.value
    const benchJudged = scores.overall?.judged ?? scores.accuracy?.judged ?? scores.scored
    const benchCorrect = scores.overall?.correct ?? scores.accuracy?.correct
    const qualityNote = benchAccuracy === null || benchAccuracy === undefined
      ? "无已判分样本"
      : `${dataset === "locomo" ? "平均 F1" : "正确率"} ${(benchAccuracy * 100).toFixed(1)}%`
        + `（${dataset === "locomo" ? `n=${benchJudged ?? "?"}` : `${benchCorrect ?? "?"}/${benchJudged ?? "?"}`}）`
    view.finish({
      verdict: benchPassed ? "pass" : "fail",
      note: `完成 ${report.completedCells}/${report.plannedCells} · ${qualityNote} · 观测指标非门禁阈值；详见 JSON 报告（terminal 报告含逐 case 明细）`
        + (benchPassed ? "" : " · 存在未完成或失败题，见上方红行"),
    })
    await finishSpecialReport(bridge, {
      ...report,
      runEvidence: { commit: manifest.commit, sourceHashes: manifest.sourceHashes, seedHash: manifest.seedHash },
    }, benchPassed)
    return
  }

  // ── 场景模式 ──

  const contracts = collectContracts(input.contractModules)
  const allScenes = collectScenes(input.sceneModules)
  const contractResults = checkAllContracts(contracts, allScenes, parseHashAttestation(raw.sourceHashes ?? undefined))
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
  manifest.expectedTrials = prepared.flatMap(scene =>
    Array.from({ length: plannedTrialCount([scene], opts.repeat) }, (_, index) => ({ caseId: scene.meta.caseId, sceneId: scene.meta.caseId, trialId: String(index + 1) })),
  )
  await writeManifest(false)

  const progressView: ProgressView = createConsoleProgressView(totalTrials, { reportPath: resultFilePath() })

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
      userAgent: `node ${process.version}`,
      platform: process.platform,
      seedHash: raw.seedHash ?? undefined,
      commit: raw.commit ?? undefined,
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
    traceCompleted = true
    await writeManifest(true)
    await bridge.request("e2e_complete", { passed: false, report: formatted })
    return
  }

  const results: TestReport["scenes"] = []
  for (const scene of prepared) {
    // 一次只喂一个场景给 runAllScenes：超时后跳过同场景剩余 trial 的策略在它内部。
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
        if (result.turns.some(turn => turn.expectedFailure)) progressView.expectedFailure(key, result.duration)
        else progressView.pass(key, result.duration)
        continue
      }
      // 失败行立即展开：断言差异 + 失败窗口的事件序列。
      progressView.fail(key, result.duration, [
        ...formatSceneFailure(result),
        ...formatTraceEvents(traceRecorder!.recent.slice(-TRACE_WINDOW_SIZE), traceRecorder!.status.recorded),
      ])
    }
    results.push(...sceneResults)
  }

  const report: TestReport = { ...reportBase, scenes: results, summary: makeSummary(results, totalTrials) }
  const formatted = formatReport(report, opts.report)
  console.log(formatted)
  await traceRecorder.complete()
  traceCompleted = true
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
        // 一条都没跑（选择条件没命中）与「跑了但有失败」是两种不同的结论，终端要分开说。
        results.length === 0 ? "没有任何场景被执行：检查 --module / --case / --tag / --suite 选择条件" : "",
        `失败 ${report.summary.failed} · 超时 ${report.summary.timeout} · 跳过 ${report.summary.skipped}`,
      ].filter(Boolean).join("；"),
  })
  await bridge.request("e2e_complete", { passed, report: formatted })
}
