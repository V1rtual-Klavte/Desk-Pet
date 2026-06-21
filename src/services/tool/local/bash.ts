// ==========================================
// 本地工具：Bash 白名单命令 (NORMAL，轻量模式)
// 仅允许白名单中的安全命令
// ==========================================

import type { ToolDef } from "../types"
import { register } from "../registry"
import { invoke } from "@tauri-apps/api/core"
import { toolsConfig } from "@/services/config"
import { BASH_DANGEROUS_PATTERNS, matchesAnyPattern } from "@/services/safety/checker"
import { createLogger } from "@/services/logger"

const log = createLogger("ToolBash")

const bashTool: ToolDef = {
  id: "local-bash",
  name: "bash_exec",
  description: "执行系统命令（仅限安全白名单）。可用于查看文件、目录、系统状态等。",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的命令" },
      cwd: { type: "string", description: "工作目录（可选）" },
    },
    required: ["command"],
  },
  safetyLevel: "NORMAL",
  source: "local",
  sourceId: "",
  mode: "pet",
  timeoutMs: 15000,
  personalityHint: {
    executing: "让我来处理...",
    done: "搞定！",
    blocked: "这个命令不能执行呢～",
  },
  async handler(params) {
    const command = String(params.command).trim()
    const cwd = params.cwd ? String(params.cwd) : undefined

    // ── 白名单检查 ──
    const whitelist = toolsConfig.bashWhitelist
    const baseCmd = command.split(/\s+/)[0]
    if (!whitelist.includes(baseCmd)) {
      return {
        success: false,
        content: "",
        error: `命令 "${baseCmd}" 不在白名单中。轻量模式允许: ${whitelist.join(", ")}`,
      }
    }

    // ── 危险参数检测（统一模式库）──
    if (matchesAnyPattern(command, BASH_DANGEROUS_PATTERNS)) {
      return { success: false, content: "", error: "命令包含危险操作，已拦截" }
    }

    try {
      const result = await invoke<{ stdout: string; stderr: string; exitCode: number }>("bash_exec", {
        command,
        cwd: cwd || null,
      })
      const output = result.stdout || result.stderr
      const truncated = output.length > 4000
        ? output.substring(0, 4000) + "\n...(输出已截断)"
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

export function registerBashTool(): void {
  register(bashTool)
  log.info("Bash 工具已注册 (白名单模式)")
}
