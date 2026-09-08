import { invoke } from "@tauri-apps/api/core"
import { runAllScenes } from "./scene-runner"
import { standardSetup } from "./standard-setup"
import { formatReport } from "./reporter"
import { checkAllContracts } from "./contract-checker"
import { parseArgs } from "./cli"
import type { ModuleContract, SceneDef, TestReport } from "./types"

const sceneModules = import.meta.glob<{ default?: SceneDef }>("./scenes/**/*.scene.ts", { eager: true })
const contractModules = import.meta.glob<Record<string, ModuleContract>>("./contracts/*.contract.ts", { eager: true })

function collectScenes(): SceneDef[] {
  return Object.values(sceneModules)
    .map(mod => mod.default ?? Object.values(mod).find(v => v && typeof v === "object" && "meta" in v) as SceneDef)
    .filter((scene): scene is SceneDef => Boolean(scene?.meta))
}

function collectContracts(): ModuleContract[] {
  return Object.values(contractModules)
    .flatMap(mod => Object.values(mod))
    .filter((contract): contract is ModuleContract => Boolean(contract?.module && contract?.coverage))
}

async function main(): Promise<void> {
  const rawOptions = await invoke<{ module?: string; scene?: string; tag?: string; report?: string }>("get_live_test_options")
  const opts = parseArgs([
    ...(rawOptions.module ? ["--module", rawOptions.module] : []),
    ...(rawOptions.scene ? ["--scene", rawOptions.scene] : []),
    ...(rawOptions.tag ? ["--tag", rawOptions.tag] : []),
    ...(rawOptions.report ? ["--report", rawOptions.report] : []),
  ])

  await standardSetup()

  const contractResults = checkAllContracts(collectContracts())
  for (const cr of contractResults) {
    for (const m of cr.missing) console.warn(`[MISSING] ${cr.module}/${m}: ${m}`)
    for (const g of cr.gaps) console.error(g)
  }

  let scenes = collectScenes()
  if (opts.module) scenes = scenes.filter(s => s.meta.module === opts.module)
  if (opts.scene) scenes = scenes.filter(s => s.meta.description.includes(opts.scene!))
  if (opts.tag) scenes = scenes.filter(s => s.meta.tags?.includes(opts.tag!))
  for (const scene of scenes) if (!scene.setup) scene.setup = standardSetup

  const results = await runAllScenes(scenes)
  const report: TestReport = {
    timestamp: new Date().toISOString().replace("T", " ").slice(0, 19),
    scenes: results,
    summary: {
      total: results.length,
      passed: results.filter(r => r.status === "pass").length,
      failed: results.filter(r => r.status === "fail").length,
      skipped: results.filter(r => r.status === "skip").length,
      timeout: results.filter(r => r.status === "timeout").length,
      totalDuration: results.reduce((s, r) => s + r.duration, 0),
    },
  }
  const formatted = formatReport(report, opts.report)
  console.log(formatted)
  const passed = report.summary.failed === 0 && report.summary.timeout === 0 && report.summary.total > 0
  await invoke("live_test_complete", { passed, report: formatted })
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error)
  console.error("[LiveTest] 启动或执行失败", message)
  try { await invoke("live_test_complete", { passed: false, report: message }) } catch { /* app may not be ready */ }
})
