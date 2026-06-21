// ==========================================
// 安全控制 (轻量模式) —— 简洁策略
// SAFE → 放行 / NORMAL/DANGER/NOWAY → 直接拒绝
// 助手模式使用 full-checker.ts
// ==========================================

import type { SafetyLevel, ToolDef, ToolContext } from "@/services/tool/types"
import { createLogger } from "@/services/logger"

const log = createLogger("Safety")

// ═══════════════════════════════════════════════════════════════
// 统一危险模式库 —— 所有工具共享，避免散落各处
// ═══════════════════════════════════════════════════════════════

/** Bash 命令危险模式 — NORMAL 级别拦截 */
export const BASH_DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+-rf\b/, /\bsudo\b/, /\bchmod\s+777\b/,
  />\s*\/dev\//, /\bcurl\b.*\|\s*(ba)?sh\b/,
  /\bmkfs\b/, /\bdd\s+if=/,
]

/** Bash 命令硬禁止模式 — 即使助手模式也拦截 */
export const BASH_NOWAY_PATTERNS: RegExp[] = [
  /\brm\s+-rf\s+\/\b/, /\bsudo\s+rm\b/, /\bmkfs\b/,
  /\bdd\s+if=.*of=\/dev\//, /\bcurl\b.*\|\s*(ba)?sh\b/,
  />\s*\/etc\//,
]

/** 文件路径危险模式 */
export const FILE_DANGEROUS_PATTERNS: RegExp[] = [
  /\/\.ssh\//, /\/etc\/passwd/, /\/etc\/shadow/,
  /\/System\//, /\/Windows\//,
  /\.pem$/, /\.key$/, /\.env$/,
]

/** 检测文本是否匹配任一危险模式 */
export function matchesAnyPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(text))
}

/** 安全校验结果 */
export interface SafetyCheckResult {
  allowed: boolean
  reason?: string
  /** 人格化拒绝文案 */
  personalityMessage?: string
}

/**
 * 轻量模式安全检查。
 * SAFE → 放行，其余 → 拒绝并给出人格化提示。
 */
export function checkSafety(tool: ToolDef, params: Record<string, unknown>, ctx: ToolContext): SafetyCheckResult {
  const level = tool.safetyLevel

  switch (level) {
    case "SAFE":
      log.debug("SAFE 放行:", tool.name)
      return { allowed: true }

    case "NORMAL":
    case "DANGER":
      // 轻量模式：NORMAL/DANGER 直接拒绝
      log.info("轻量模式拒绝:", tool.name, "| level:", level)
      return {
        allowed: false,
        reason: `轻量模式不支持 ${level} 级别工具`,
        personalityMessage: tool.personalityHint?.blocked
          ?? "这个功能需要在助手模式下使用哦～",
      }

    case "NOWAY":
      log.warn("NOWAY 硬拒绝:", tool.name)
      return {
        allowed: false,
        reason: "硬禁止操作",
        personalityMessage: "唔...这个绝对不能做呢！",
      }

    default:
      return {
        allowed: false,
        reason: "未知安全级别",
        personalityMessage: "诶…这个操作有点奇怪呢～",
      }
  }
}

/** 批量检查多个工具调用 */
export function checkAll(
  tools: { tool: ToolDef; params: Record<string, unknown> }[],
  ctx: ToolContext,
): { allowed: boolean; results: SafetyCheckResult[] } {
  const results = tools.map(({ tool, params }) => checkSafety(tool, params, ctx))
  const allAllowed = results.every(r => r.allowed)
  return { allowed: allAllowed, results }
}
