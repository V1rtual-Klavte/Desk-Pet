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
import { TOOL_POLICY_VERSION } from "../types"
import type { SafetyLevel } from "../types"
import { createLogger } from "@/services/logger"
import { toolsConfig } from "@/services/config"
import {
  BASH_DANGEROUS_PATTERNS,
  BASH_NOWAY_PATTERNS,
  matchesAnyPattern,
  maxSafetyLevel,
  resolveFilePathLevel,
} from "@/services/safety/checker"

const log = createLogger("PiTools")

export async function registerPiBaseTools(): Promise<void> {
  const cwd = await TauriExecutionEnv.defaultCwd()
  const createEnv = () => new TauriExecutionEnv(cwd)
  const read = createReadTool<{ env: ExecutionEnv }>()
  const write = createWriteTool<{ env: ExecutionEnv }>()
  const edit = createEditTool<{ env: ExecutionEnv }>()
  const bash = createBashTool<{ env: ExecutionEnv }>()

  // 写类工具的固有等级是常量 DANGER（写能力恒暴露，不做开关）；路径风险只在此基础上加码，不降级
  const classifyWriteRisk = (params: Record<string, unknown>) =>
    maxSafetyLevel("DANGER", resolveFilePathLevel(params.path))

  registerAll([
    adaptHarnessTool(read, createEnv, {
      id: "pi-read", safetyLevel: "SAFE", actionCategory: "fs.read",
      // 只读不等于无害：私钥凭据类路径只读一次就足以泄露
      resolveSafetyLevel: params => resolveFilePathLevel(params.path),
      // 只读能力可与同批其它读取并发；敏感路径仍会在风险维度提高为 ask/deny。
      policy: {
        version: TOOL_POLICY_VERSION,
        permission: { defaultDecision: "allow" },
        execution: { effect: "read", isolation: "shared_read", replay: "never" },
        context: { resultProjection: "reference", historyCompaction: "summarize" },
      },
    }),
    adaptHarnessTool(write, createEnv, {
      id: "pi-write", safetyLevel: "DANGER", actionCategory: "fs.write",
      resolveSafetyLevel: classifyWriteRisk,
      // 工具侧不额外表态：改文件的风险与确认由风险维度与总策略给出。
      policy: {
        version: TOOL_POLICY_VERSION,
        permission: { defaultDecision: "passthrough" },
        execution: { effect: "local_mutation", isolation: "exclusive_effect", replay: "never" },
        context: { resultProjection: "preserve", historyCompaction: "summarize" },
      },
    }),
    adaptHarnessTool(edit, createEnv, {
      id: "pi-edit", safetyLevel: "DANGER", actionCategory: "fs.write",
      resolveSafetyLevel: classifyWriteRisk,
      policy: {
        version: TOOL_POLICY_VERSION,
        permission: { defaultDecision: "passthrough" },
        execution: { effect: "local_mutation", isolation: "exclusive_effect", replay: "never" },
        context: { resultProjection: "preserve", historyCompaction: "summarize" },
      },
    }),
    adaptHarnessTool(bash, createEnv, {
      id: "pi-bash", safetyLevel: "NORMAL", actionCategory: "os.exec",
      resolveSafetyLevel: classifyBashRisk,
      // 参数级风险由 resolveSafetyLevel 给出，不能仅凭工具名放行。
      policy: {
        version: TOOL_POLICY_VERSION,
        permission: { defaultDecision: "passthrough" },
        execution: { effect: "process", isolation: "exclusive_effect", replay: "never" },
        context: { resultProjection: "reference", historyCompaction: "summarize" },
      },
    }),
  ])
  log.info("Pi 基础工具已注册: read/write/edit/bash")
}

/** 从 bash 命令里切出可能的路径 token 并逐个分级。
 *  跳过选项（`-x`）与整段单引号包裹的字面量（与 Rust tokenizer 的 single_quoted 语义一致）；
 *  双引号包裹的仍要判：双引号里可能有 `$()`/反引号展开。 */
function classifyBashPaths(command: string): SafetyLevel {
  let level: SafetyLevel = "SAFE"
  for (const raw of command.split(/\s+/)) {
    if (/^'.*'$/.test(raw) && !raw.includes("$(") && !raw.includes("`")) continue
    const token = raw.replace(/^['"`;&|<>()]+/, "").replace(/['"`;&|<>()]+$/, "")
    if (!token || token.startsWith("-")) continue
    level = maxSafetyLevel(level, resolveFilePathLevel(token))
  }
  return level
}

/** 实取 NORMAL | DANGER | NOWAY —— 命令模式匹配管「做什么」，路径级检查管「对谁做」。
 *  白名单命令（且无 shell 组合语法）保持 NORMAL，裁决层对 NORMAL 一律放行：
 *  白名单只是免确认通道，不是硬墙。 */
function classifyBashRisk(params: Record<string, unknown>): SafetyLevel {
  const command = String(params.command ?? "").trim()
  if (!command) return "DANGER"
  if (matchesAnyPattern(command, BASH_NOWAY_PATTERNS)) return "NOWAY"
  if (matchesAnyPattern(command, BASH_DANGEROUS_PATTERNS)) return "DANGER"
  const first = command.split(/\s+/)[0]
  const hasShellControl = /[;&|<>`\n]|\$\(|\$\{/.test(command)
  const base: SafetyLevel = !hasShellControl && toolsConfig.bashWhitelist.includes(first) ? "NORMAL" : "DANGER"
  // 路径级检查放在模式匹配之后：命中 NOWAY 直接硬拒绝，不降成按安全模式确认的 DANGER
  return maxSafetyLevel(base, classifyBashPaths(command))
}
