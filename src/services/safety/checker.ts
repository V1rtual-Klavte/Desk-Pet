// ==========================================
// 安全控制 —— 按模式区分策略 + 安全策略 (CONFIG safety.mode)
//
// 四级安全:
//   SAFE    — 直接放行，任何模式
//   NORMAL  — 轻量放行 / 助手首次确认→会话内信任
//   DANGER  — 轻量拒绝 / 助手每次确认 (just_do_it 跳过)
//   NOWAY   — 永远硬拒绝
//
// 安全模式 (safety.mode):
//   just_do_it — DANGER 也放行，不弹确认窗
//   tell_me    — 按规则弹确认窗，告知式（默认）
//   let_me_tk  — 所有非 SAFE 都要确认（最保守）
//
// 会话信任 (safety.sessionTrustEnabled):
//   助手模式下 NORMAL 首次确认后可缓存信任，本会话不再问同工具
// ==========================================

import type { SafetyLevel, ToolDef, ToolContext } from "@/services/tool/types"
import { safetyConfig } from "@/services/config"
import { getEffectiveSafetyMode } from "@/services/debug"
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

/** Bash 命令硬禁止模式 — 所有模式永远拦截 */
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

// ═══════════════════════════════════════════════════════════════
// 安全校验结果
// ═══════════════════════════════════════════════════════════════

export interface SafetyCheckResult {
  allowed: boolean
  reason?: string
  /** 人格化拒绝文案 */
  personalityMessage?: string
  /** 需要用户确认 */
  needsConfirm?: boolean
  /** 确认提示信息 */
  confirmMessage?: string
}

// ── 会话内信任缓存 ──

let sessionTrustedTools = new Set<string>()

/** 将某工具标记为会话内已信任（NORMAL 确认通过后） */
export function trustToolInSession(toolName: string): void {
  sessionTrustedTools.add(toolName)
  log.debug("会话信任:", toolName)
}

/** 检查工具是否已被会话信任 */
export function isToolTrusted(toolName: string): boolean {
  return sessionTrustedTools.has(toolName)
}

/** 重置会话信任（新会话时调用） */
export function resetSessionTrust(): void {
  sessionTrustedTools.clear()
  log.debug("会话信任已重置")
}

// ═══════════════════════════════════════════════════════════════
// 统一安全检查
// ═══════════════════════════════════════════════════════════════

/**
 * 统一安全检查 —— 按 ctx.mode + safety.mode 区分策略。
 *
 * 轻量模式 (pet):
 *   SAFE    → 直接放行
 *   NORMAL  → 放行（工具 handler 自带白名单/危险模式校验）
 *   DANGER  → 拒绝
 *   NOWAY   → 硬拒绝
 *
 * 助手模式 (assistant):
 *   SAFE    → 直接放行
 *   NORMAL  → 首次确认后可会话内信任（sessionTrustEnabled=true 时）
 *   DANGER  → just_do_it 放行 / 否则每次确认
 *   NOWAY   → 硬拒绝
 */
export function checkSafety(
  tool: ToolDef,
  params: Record<string, unknown>,
  ctx: ToolContext,
): SafetyCheckResult {
  const level = tool.safetyLevel
  const isAssistant = ctx.mode === "assistant"
  const safetyMode = getEffectiveSafetyMode()
  const trustEnabled = safetyConfig.sessionTrustEnabled

  switch (level) {
    case "SAFE":
      log.debug("SAFE 放行:", tool.name)
      return { allowed: true }

    case "NORMAL": {
      if (!isAssistant) {
        // 轻量模式 NORMAL: 放行（handler 层有 bash 白名单等二次校验）
        log.debug("轻量模式 NORMAL 放行:", tool.name)
        return { allowed: true }
      }

      // 助手模式 NORMAL
      // let_me_tk → 所有非SAFE都要确认
      if (safetyMode === "let_me_tk") {
        return {
          allowed: true,
          needsConfirm: true,
          confirmMessage: `🔧 工具 "${tool.name}" 安全级别 NORMAL，需要确认执行。`,
        }
      }

      // 会话已信任 → 跳过确认
      if (trustEnabled && isToolTrusted(tool.name)) {
        log.info("助手模式 NORMAL 放行 (会话已信任):", tool.name)
        return { allowed: true }
      }

      // 首次 → 需要确认
      log.info("助手模式 NORMAL 需要确认:", tool.name)
      return {
        allowed: true,
        needsConfirm: true,
        confirmMessage: `🔧 "${tool.name}" 将执行系统操作。本会话可记住此选择。`,
      }
    }

    case "DANGER": {
      if (!isAssistant) {
        // 轻量模式：DANGER 直接拒绝
        log.info("轻量模式拒绝 DANGER:", tool.name)
        return {
          allowed: false,
          reason: "轻量模式不支持 DANGER 级别工具",
          personalityMessage: tool.personalityHint?.blocked
            ?? "这个功能需要在助手模式下使用哦～",
        }
      }

      // 助手模式 DANGER
      // just_do_it → 不确认，直接放行
      if (safetyMode === "just_do_it") {
        log.warn("助手模式 DANGER 放行 (just_do_it):", tool.name)
        return { allowed: true }
      }

      // tell_me / let_me_tk → 每次都确认
      log.warn("助手模式 DANGER 需要确认:", tool.name)
      return {
        allowed: true,
        needsConfirm: true,
        confirmMessage: `⚠️ "${tool.name}" 是高风险操作！确认执行？`,
      }
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
