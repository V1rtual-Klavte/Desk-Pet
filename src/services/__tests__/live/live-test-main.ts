import { invoke } from "@tauri-apps/api/core"
import { validateDataset, LIVE_DATASET_VERSION } from "./dataset"
import { runAllScenes, plannedTrialCount } from "./scene-runner"
import { standardSetup } from "./standard-setup"
import { formatReport } from "./reporter"
import { checkAllContracts } from "./contract-checker"
import { parseArgs } from "./cli"
import type { ModuleContract, SceneDef, TestReport } from "./types"
import { initPaths } from "@/services/paths"
import { initConfig } from "@/services/config"
import { installGlobalHandlers, reportError } from "@/services/error"

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
  commit?: string
}

const sceneModules = import.meta.glob<{ default?: SceneDef }>("./scenes/**/*.scene.ts", { eager: true })
const contractModules = import.meta.glob<Record<string, ModuleContract>>("./contracts/*.contract.ts", { eager: true })

function collectScenes(): SceneDef[] {
  const scenes = Object.values(sceneModules)
    .flatMap(module => Object.values(module))
    .filter((scene): scene is SceneDef => Boolean(scene && typeof scene === "object" && "meta" in scene && scene.meta))
  return [...new Map(scenes.map(scene => [scene.meta.caseId, scene])).values()]
}

function collectContracts(): ModuleContract[] {
  const contracts = Object.values(contractModules)
    .flatMap(module => Object.values(module))
    .filter((contract): contract is ModuleContract => Boolean(contract?.module && contract?.coverage))
  return [...new Map(contracts.map(contract => [contract.module, contract])).values()]
}

function withStandardSetup(scene: SceneDef): SceneDef {
  const sceneSetup = scene.setup
  return {
    ...scene,
    setup: async () => {
      // 场景声明在这里落到宿主的确认通道上：withStandardSetup 是唯一同时持有
      // 场景元数据与 setup 包装的位置（确认通道本身由 standard-setup 负责重置）。
      await standardSetup(scene.meta.confirmPolicy)
      await sceneSetup?.()
    },
  }
}

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
  const raw = await invoke<RuntimeOptions>("get_live_test_options")
  const opts = parseArgs([
    ...(raw.module ? ["--module", raw.module] : []),
    ...(raw.scene ? ["--scene", raw.scene] : []),
    ...(raw.case ? ["--case", raw.case] : []),
    ...(raw.tag ? ["--tag", raw.tag] : []),
    ...(raw.suite ? ["--suite", raw.suite] : []),
    ...(raw.repeat ? ["--repeat", raw.repeat] : []),
    ...(raw.strict === "1" ? ["--strict"] : []),
    ...(raw.report ? ["--report", raw.report] : []),
  ])

  const contracts = collectContracts()
  const allScenes = collectScenes()
  const contractResults = checkAllContracts(contracts, allScenes)
  for (const result of contractResults) {
    for (const missing of result.missing) console.warn(`[MISSING] ${result.module}/${missing}: ${missing}`)
    for (const gap of result.gaps) console.error(gap)
  }

  let scenes = allScenes
  if (opts.module) scenes = scenes.filter(scene => scene.meta.module === opts.module)
  if (opts.scene) scenes = scenes.filter(scene => scene.meta.description.includes(opts.scene!))
  if (opts.caseId) scenes = scenes.filter(scene => scene.meta.caseId === opts.caseId)
  if (opts.tag) scenes = scenes.filter(scene => scene.meta.tags?.includes(opts.tag!))
  if (opts.suite) scenes = scenes.filter(scene => scene.meta.suite === opts.suite)

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
    await invoke("live_test_complete", { passed: false, report: formatted })
    return
  }

  const results = await runAllScenes(scenes.map(withStandardSetup), opts.repeat)
  const report: TestReport = { ...reportBase, scenes: results, summary: makeSummary(results, plannedTrialCount(scenes, opts.repeat)) }
  const formatted = formatReport(report, opts.report)
  console.log(formatted)
  const passed = report.summary.failed === 0
    && report.summary.timeout === 0
    && report.summary.total > 0
    && report.datasetErrors.length === 0
    && (!opts.strictContracts || report.contracts.every(contract => contract.valid))
  await invoke("live_test_complete", { passed, report: formatted })
}

// 测试报告本身走 console（见上方 formatReport），这里只补「未捕获异常也要有出口」。
// overlay: false —— 独立测试窗口不需要弹覆盖层，日志与报告已足够。
installGlobalHandlers("live-test", { overlay: false })

main().catch(async error => {
  const message = error instanceof Error ? error.stack || error.message : String(error)
  reportError("live-test", error, { kind: "启动或执行失败" })
  try { await invoke("live_test_complete", { passed: false, report: message }) } catch { /* app may not be ready */ }
})
