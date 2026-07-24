// ==========================================
// CLI — 参数解析 (vitest 执行前)
// ==========================================

export interface CLIOptions {
  module?: string
  scene?: string
  tag?: string
  report: "terminal" | "json" | "markdown"
}

export function parseArgs(args: string[]): CLIOptions {
  const opts: CLIOptions = { report: "terminal" }

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === "--module" && args[i + 1]) {
      opts.module = args[++i]
    } else if (a === "--scene" && args[i + 1]) {
      opts.scene = args[++i]
    } else if (a === "--tag" && args[i + 1]) {
      opts.tag = args[++i]
    } else if (a === "--report" && args[i + 1]) {
      const fmt = args[++i]
      if (fmt === "json" || fmt === "markdown" || fmt === "terminal") {
        opts.report = fmt
      }
    }
  }

  return opts
}

/** 获取 process.argv 中的非 vitest 参数 */
export function getUserArgs(): string[] {
  return process.argv.slice(2).filter(a => !a.startsWith("--config"))
}
