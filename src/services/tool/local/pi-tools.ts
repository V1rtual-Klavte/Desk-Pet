import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-agent-core"
import type { ExecutionEnv } from "@earendil-works/pi-agent-core"
import { registerAll } from "../registry"
import { adaptHarnessTool } from "../pi/harness-adapter"
import { TauriExecutionEnv } from "../pi/tauri-execution-env"
import { createLogger } from "@/services/logger"
import { toolsConfig } from "@/services/config"
import { BASH_DANGEROUS_PATTERNS, BASH_NOWAY_PATTERNS, matchesAnyPattern } from "@/services/safety/checker"

const log = createLogger("PiTools")

export async function registerPiBaseTools(): Promise<void> {
  const cwd = await TauriExecutionEnv.defaultCwd()
  const createEnv = (mode: "pet" | "assistant") => new TauriExecutionEnv(cwd, mode)
  const read = createReadTool<{ env: ExecutionEnv }>()
  const write = createWriteTool<{ env: ExecutionEnv }>()
  const edit = createEditTool<{ env: ExecutionEnv }>()
  const bash = createBashTool<{ env: ExecutionEnv }>()

  registerAll([
    adaptHarnessTool(read, ctx => createEnv(ctx.mode), { id: "pi-read", safetyLevel: "SAFE", actionCategory: "fs.read" }),
    {
      ...adaptHarnessTool(write, ctx => createEnv(ctx.mode), { id: "pi-write", safetyLevel: "DANGER", actionCategory: "fs.write" }),
      lightweightPolicy: "confirm",
      resolveSafetyLevel: () => !toolsConfig.fileWriteEnabled ? "NOWAY" : "DANGER",
    },
    {
      ...adaptHarnessTool(edit, ctx => createEnv(ctx.mode), { id: "pi-edit", safetyLevel: "DANGER", actionCategory: "fs.write" }),
      lightweightPolicy: "confirm",
      resolveSafetyLevel: () => !toolsConfig.fileWriteEnabled ? "NOWAY" : "DANGER",
    },
    {
      ...adaptHarnessTool(bash, ctx => createEnv(ctx.mode), { id: "pi-bash", safetyLevel: "NORMAL", actionCategory: "os.exec" }),
      lightweightPolicy: "confirm",
      resolveSafetyLevel: classifyBashRisk,
    },
  ])
  log.info("Pi 基础工具已注册: read/write/edit/bash")
}

function classifyBashRisk(params: Record<string, unknown>): "NORMAL" | "DANGER" | "NOWAY" {
  const command = String(params.command ?? "").trim()
  if (!command) return "DANGER"
  if (matchesAnyPattern(command, BASH_NOWAY_PATTERNS)) return "NOWAY"
  if (matchesAnyPattern(command, BASH_DANGEROUS_PATTERNS)) return "DANGER"

  const first = command.split(/\s+/)[0]
  const hasShellControl = /[;&|<>`\n]|\$\(|\$\{/.test(command)
  return !hasShellControl && toolsConfig.bashWhitelist.includes(first) ? "NORMAL" : "DANGER"
}
