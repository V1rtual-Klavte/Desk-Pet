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
import { initConfig } from "@/services/config"
import { installGlobalHandlers, reportError, formatError } from "@/services/error"
import { subscribeRuntimeTrace } from "@/services/engine/runtime"
import type { RuntimeTraceEvent } from "@/services/engine/runtime"

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
const traceWindow: RuntimeTraceEvent[] = []
let traceSeen = 0
subscribeRuntimeTrace(event => {
  traceSeen += 1
  traceWindow.push(event)
  if (traceWindow.length > TRACE_WINDOW_SIZE) traceWindow.shift()
})

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
    traceSeen = 0
    traceWindow.length = 0
    // 一次只喂一个场景给 runAllScenes：超时后跳过同场景剩余 trial 的策略在它内部，
    // 拆批不改语义（批之间没有共享状态），换来的是一跑完就能逐条结算。
    // 批内没有逐 trial 回调，所以进行中标记只能落在这个场景最早未结算的行上；
    // repeat>1 时它可能落后于真实回合，状态与耗时不受影响。
    progressView.start(rowKey(scene.meta.caseId, 1), scene.meta.caseId, scene.meta.description)
    const sceneResults = await runAllScenes([scene], opts.repeat)
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
        ...formatTraceEvents(traceWindow, traceSeen),
      ])
    }
    results.push(...sceneResults)
  }

  const report: TestReport = { ...reportBase, scenes: results, summary: makeSummary(results, totalTrials) }
  const formatted = formatReport(report, opts.report)
  console.log(formatted)
  const passed = report.summary.failed === 0
    && report.summary.timeout === 0
    && report.summary.total > 0
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
  try { await invoke("e2e_complete", { passed: false, report: message }) } catch { /* app may not be ready */ }
})
