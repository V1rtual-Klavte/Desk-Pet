// ==========================================
// Live Test — vitest 入口
// ==========================================

import { describe, it, expect, beforeAll } from "vitest"
import { runAllScenes } from "./scene-runner"
import { standardSetup } from "./standard-setup"
import { formatReport } from "./reporter"
import { checkAllContracts } from "./contract-checker"
import { parseArgs, getUserArgs } from "./cli"
import type { SceneDef, TestReport, SceneResult } from "./types"
import * as path from "path"
import * as fs from "fs"

const opts = parseArgs(getUserArgs())
const CONTRACTS_DIR = path.join(__dirname, "contracts")

// ── 动态加载所有场景 ──

async function loadScenes(): Promise<SceneDef[]> {
  const scenes: SceneDef[] = []
  const loaders: Promise<void>[] = []
  const scenesDir = path.join(__dirname, "scenes")

  function scanDir(dir: string) {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        scanDir(full)
      } else if (entry.name.endsWith(".scene.ts")) {
        loaders.push(
          import(full).then(mod => {
            const scene: SceneDef = mod.default || mod[Object.keys(mod).find(k => !k.startsWith("_")) || ""]
            if (scene?.meta) scenes.push(scene)
          }).catch(err => {
            console.warn(`[WARN] 加载场景失败: ${full} — ${err.message}`)
          })
        )
      }
    }
  }

  scanDir(scenesDir)
  await Promise.all(loaders)
  return scenes
}

// ── 测试套件 ──

let results: SceneResult[] = []

describe("Live Test", () => {
  beforeAll(async () => {
    // 1. Contract 完整性检查
    const contractResults = await checkAllContracts(CONTRACTS_DIR)
    for (const cr of contractResults) {
      if (cr.stale) {
        console.error(`[STALE] ${cr.module}: 源码已变更，请运行 /analyze test`)
      }
      for (const m of cr.missing) {
        console.warn(`[MISSING] ${cr.module}/${m}: 没有场景覆盖`)
      }
      for (const g of cr.gaps) {
        console.error(g)
      }
    }

    const hasStale = contractResults.some(c => c.stale)
    if (hasStale) {
      throw new Error("Contract hash 过期，请运行 /analyze test 重新生成")
    }

    // 2. 加载场景（过滤）
    let scenes = await loadScenes()
    if (opts.module) {
      scenes = scenes.filter(s => s.meta.module === opts.module)
    }
    if (opts.scene) {
      scenes = scenes.filter(s => s.meta.description.includes(opts.scene!))
    }
    if (opts.tag) {
      scenes = scenes.filter(s => s.meta.tags?.includes(opts.tag!))
    }

    // 3. 如果没有自定义 setup，使用标准 setup
    for (const scene of scenes) {
      if (!scene.setup) {
        scene.setup = standardSetup
      }
    }

    // 4. 执行
    results = await runAllScenes(scenes)
  })

  it("所有场景必须通过", () => {
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

    console.log(formatReport(report, opts.report))

    // 每个失败场景都要报出来
    for (const r of results) {
      if (r.status === "fail") {
        const failedTurns = r.turns.filter(t => t.assertions.some(a => !a.pass))
        const details = failedTurns.map(t =>
          `  T${t.index}: ${t.assertions.filter(a => !a.pass).map(a => `${a.type}(${a.error})`).join(", ")}`
        ).join("\n")
        console.error(`\n❌ ${r.module}/${r.scene}:\n${details}`)
      }
    }

    expect(report.summary.failed).toBe(0)
    expect(report.summary.timeout).toBe(0)
  })
})
