// ==========================================
// 助手模式工具：全量 Bash (DANGER)
// 覆盖白名单限制，可执行任意命令
// ==========================================

import type { ToolDef } from "../types"
import { register } from "../registry"
import { invoke } from "@tauri-apps/api/core"
import { BASH_NOWAY_PATTERNS, matchesAnyPattern } from "@/services/safety/checker"
import { createLogger } from "@/services/logger"

const log = createLogger("ToolBashF")

const bashFullTool: ToolDef = {
  id: "local-bash-full",
  name: "bash_exec_full",
  description: "执行任意系统命令（无白名单限制）。助手模式专用，每次需单独确认。",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的命令" },
      cwd: { type: "string", description: "工作目录（可选）" },
    },
    required: ["command"],
  },
  safetyLevel: "DANGER",
  source: "local",
  sourceId: "",
  mode: "assistant",
  timeoutMs: 30000,
  personalityHint: {
    executing: "让我来处理...",
    done: "搞定！",
    blocked: "这个命令太危险了，不能执行哦～",
  },
  async handler(params) {
    const command = String(params.command).trim()
    const cwd = params.cwd ? String(params.cwd) : undefined

    // 硬禁止模式（统一模式库）
    if (matchesAnyPattern(command, BASH_NOWAY_PATTERNS)) {
      return { success: false, content: "", error: "此命令被硬禁止执行" }
    }

    try {
      const result = await invoke<{ stdout: string; stderr: string; exitCode: number }>("bash_exec", {
        command,
        cwd: cwd || null,
      })
      const output = result.stdout || result.stderr
      const truncated = output.length > 8000
        ? output.substring(0, 8000) + "\n...(输出已截断)"
        : output
      return {
        success: result.exitCode === 0,
        content: truncated || "(无输出)",
        error: result.exitCode !== 0 ? `exit code: ${result.exitCode}` : undefined,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { success: false, content: "", error: msg }
    }
  },
}

export function registerBashFullTool(): void {
  register(bashFullTool)
  log.info("全量 Bash 工具已注册 (bash.exec_full)")
}
