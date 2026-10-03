// ==========================================
// CLI — Live Test 参数解析
// ==========================================

export interface CLIOptions {
  module?: string
  scene?: string
  caseId?: string
  tag?: string
  suite?: "regression" | "capability" | "safety" | "stress"
  repeat: number
  strictContracts: boolean
  trace: "off" | "light" | "full"
  quality: boolean
  qualitySeed: string
  performance: boolean
  report: "terminal" | "json" | "markdown" | "html"
}

// 选项清单必须与 scripts/e2e-test.mjs 顶部的 valueOptions / flagOptions 同步：
// 启动器（Node 侧）与浏览器侧各持一份，且启动器顶层有副作用、不能被 import 共享 ——
// 漏改一边 = 对应选项静默失效。对侧同名注释在 e2e-test.mjs 的清单上方。
export function parseArgs(args: string[]): CLIOptions {
  const opts: CLIOptions = { report: "terminal", repeat: 1, strictContracts: false, trace: "full", quality: false, qualitySeed: "memory-quality-2026-10-02", performance: false }

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === "--module" && args[i + 1]) {
      opts.module = args[++i]
    } else if (a === "--scene" && args[i + 1]) {
      opts.scene = args[++i]
    } else if (a === "--case" && args[i + 1]) {
      opts.caseId = args[++i]
    } else if (a === "--tag" && args[i + 1]) {
      opts.tag = args[++i]
    } else if (a === "--suite" && args[i + 1]) {
      const suite = args[++i]
      if (suite === "regression" || suite === "capability" || suite === "safety" || suite === "stress") {
        opts.suite = suite
      }
    } else if (a === "--repeat" && args[i + 1]) {
      const repeat = Number.parseInt(args[++i], 10)
      if (Number.isFinite(repeat) && repeat > 0) opts.repeat = Math.min(repeat, 20)
    } else if (a === "--strict") {
      opts.strictContracts = true
    } else if (a === "--quality") {
      opts.quality = true
    } else if (a === "--quality-seed" && args[i + 1]) {
      opts.qualitySeed = args[++i]
    } else if (a === "--performance") {
      opts.performance = true
    } else if (a === "--trace" && args[i + 1]) {
      const trace = args[++i]
      if (trace !== "off" && trace !== "light" && trace !== "full") throw new Error("--trace 必须为 off/light/full")
      opts.trace = trace
    } else if (a === "--report" && args[i + 1]) {
      const fmt = args[++i]
      if (fmt === "json" || fmt === "markdown" || fmt === "terminal" || fmt === "html") {
        opts.report = fmt
      }
    }
  }

  if (opts.quality && opts.performance) throw new Error("记忆质量与资源评测必须独立执行")

  return opts
}
