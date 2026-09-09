import { invoke } from "@tauri-apps/api/core"
import { validateDataset, LIVE_DATASET_VERSION } from "./dataset"
import { runAllScenes } from "./scene-runner"
import { standardSetup } from "./standard-setup"
import { formatReport } from "./reporter"
import { checkAllContracts } from "./contract-checker"
import { parseArgs } from "./cli"
import type { ModuleContract, SceneDef, TestReport } from "./types"

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
  return Object.values(sceneModules)
    .map(module => module.default ?? Object.values(module).find(value => value && typeof value === "object" && "meta" in value) as SceneDef)
    .filter((scene): scene is SceneDef => Boolean(scene?.meta))
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
      await standardSetup()
      await sceneSetup?.()
    },
  }
}

function makeSummary(results: TestReport["scenes"]): TestReport["summary"] {
  const caseResults = new Map<string, TestReport["scenes"]>()
  for (const result of results) {
    const list = caseResults.get(result.caseId) ?? []
    list.push(result)
    caseResults.set(result.caseId, list)
  }
  const passedCases = [...caseResults.values()].filter(trials => trials.some(trial => trial.status === "pass")).length
  const passedEveryTrial = [...caseResults.values()].filter(trials => trials.length > 0 && trials.every(trial => trial.status === "pass")).length
  const total = results.length
  const totalCases = caseResults.size

  return {
    total,
    passed: results.filter(result => result.status === "pass").length,
    failed: results.filter(result => result.status === "fail").length,
    skipped: results.filter(result => result.status === "skip").length,
    timeout: results.filter(result => result.status === "timeout").length,
    totalDuration: results.reduce((sum, result) => sum + result.duration, 0),
    totalCases,
    totalTrials: total,
    passRate: total === 0 ? 0 : results.filter(result => result.status === "pass").length / total,
    // pass@k: at least one successful trial; pass^k: every observed trial successful.
    passAtK: totalCases === 0 ? 0 : passedCases / totalCases,
    passPowerK: totalCases === 0 ? 0 : passedEveryTrial / totalCases,
  }
}

async function main(): Promise<void> {
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
  const contractResults = checkAllContracts(contracts)
  for (const result of contractResults) {
    for (const missing of result.missing) console.warn(`[MISSING] ${result.module}/${missing}: ${missing}`)
    for (const gap of result.gaps) console.error(gap)
  }

  let scenes = collectScenes()
  if (opts.module) scenes = scenes.filter(scene => scene.meta.module === opts.module)
  if (opts.scene) scenes = scenes.filter(scene => scene.meta.description.includes(opts.scene!))
  if (opts.caseId) scenes = scenes.filter(scene => scene.meta.caseId === opts.caseId)
  if (opts.tag) scenes = scenes.filter(scene => scene.meta.tags?.includes(opts.tag!))
  if (opts.suite) scenes = scenes.filter(scene => scene.meta.suite === opts.suite)

  const datasetErrors = validateDataset(scenes, contracts)
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
    const report: TestReport = { ...reportBase, scenes: [], summary: makeSummary([]) }
    const formatted = formatReport(report, opts.report)
    console.error(formatted)
    await invoke("live_test_complete", { passed: false, report: formatted })
    return
  }

  const results = await runAllScenes(scenes.map(withStandardSetup), opts.repeat)
  const report: TestReport = { ...reportBase, scenes: results, summary: makeSummary(results) }
  const formatted = formatReport(report, opts.report)
  console.log(formatted)
  const passed = report.summary.failed === 0
    && report.summary.timeout === 0
    && report.summary.total > 0
    && report.datasetErrors.length === 0
    && (!opts.strictContracts || report.contracts.every(contract => contract.valid))
  await invoke("live_test_complete", { passed, report: formatted })
}

main().catch(async error => {
  const message = error instanceof Error ? error.stack || error.message : String(error)
  console.error("[LiveTest] 启动或执行失败", message)
  try { await invoke("live_test_complete", { passed: false, report: message }) } catch { /* app may not be ready */ }
})
