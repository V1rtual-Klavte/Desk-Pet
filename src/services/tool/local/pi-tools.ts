import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-agent-core"
import type { ExecutionEnv } from "@earendil-works/pi-agent-core"
import { readImageProcessor } from "@/services/images"
import { registerAll } from "../registry"
import { adaptHarnessTool } from "../pi/harness-adapter"
import { NativeExecutionEnv } from "../pi/native-execution-env"
import { BASH_TOOL_TIMEOUT_MS, withBashToolPolicy } from "./bash-timeout"
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

/**
 * Bash 工具自己的执行超时档位（默认 = 上限 = 5 分钟，模型只可下调）。
 *
 * 档位语义与模型可见文案的唯一定义点在 `./bash-timeout`（零依赖叶子）。声明本身只是
 * 策略层的一半：router 用它做请求视图超时（`policy.execution.timeoutMs`），另一半是
 * `withBashToolPolicy` 把**生效值**夹取进参数并下传 Rust —— 模型不传 `timeout` 时旧链路
 * 会吃 Rust 的 120s 兜底，5 分钟档名存实亡（2026-10-06 排查，见
 * .superpowers/sdd/turn-gov/timeout-research.md 与 timeout-impl-report.md）。
 *
 * 施加点唯一：`tool/router.ts` 读 `policy.execution.timeoutMs ?? loopConfig.toolTimeoutMs`
 * （主回合 / 子运行 / 计划步骤 / 恢复路径共用同一执行入口）。
 */

export async function registerPiBaseTools(): Promise<void> {
  const cwd = await NativeExecutionEnv.defaultCwd()
  const createEnv = () => new NativeExecutionEnv(cwd)
  const read = createReadTool<{ env: ExecutionEnv }>({ imageProcessor: readImageProcessor, autoResizeImages: true })
  const write = createWriteTool<{ env: ExecutionEnv }>()
  const edit = createEditTool<{ env: ExecutionEnv }>()
  // bash 单独套档位策略：模型可见描述/参数说明 + 生效超时夹取（见 ./bash-timeout）。
  const bash = withBashToolPolicy(createBashTool<{ env: ExecutionEnv }>())

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
        // timeoutMs 见 BASH_TOOL_TIMEOUT_MS：bash 单列 5 分钟档，不吃全局 30s 默认。
        execution: { effect: "process", isolation: "exclusive_effect", replay: "never", timeoutMs: BASH_TOOL_TIMEOUT_MS },
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
