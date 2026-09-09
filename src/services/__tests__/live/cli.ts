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
  report: "terminal" | "json" | "markdown"
}

export function parseArgs(args: string[]): CLIOptions {
  const opts: CLIOptions = { report: "terminal", repeat: 1, strictContracts: false }

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
    } else if (a === "--report" && args[i + 1]) {
      const fmt = args[++i]
      if (fmt === "json" || fmt === "markdown" || fmt === "terminal") {
        opts.report = fmt
      }
    }
  }

  return opts
}
