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
// engine/runtime 是零业务副作用的协议层，不反向依赖 safety，不存在环
import { stableSerialize } from "@/services/engine/runtime"

const log = createLogger("Safety")

// ═══════════════════════════════════════════════════════════════
// 统一危险模式库 —— 所有工具共享，避免散落各处
// ═══════════════════════════════════════════════════════════════

/** Bash 命令危险模式 — NORMAL 级别拦截 */
export const BASH_DANGEROUS_PATTERNS: RegExp[] = [
  // rm 的递归删除：短选项可合并（-rf、-fr）也可分开（-r -f），并接受长选项 --recursive
  /\brm\s+(?:--?[a-zA-Z-]+\s+)*(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/,
  /\bsudo\b/, /\bchmod\s+777\b/,
  />\s*\/dev\//, /\bcurl\b.*\|\s*(ba)?sh\b/,
  /\bmkfs\b/, /\bdd\s+if=/,
]

/** Bash 命令硬禁止模式 — 所有模式永远拦截 */
export const BASH_NOWAY_PATTERNS: RegExp[] = [
  // 递归删除根目录：目标必须是 "/" 本身（后接空白或行尾）才算硬禁止，避免误杀 "rm -rf /home"。
  // 旧写法把 \b 放在 "/" 之后，而 "/" 与行尾之间不存在单词边界，断言恒为假 ——
  // 结果是 "rm -rf /" 只落到 DANGER，多空格写法（"rm  -rf  /"）同样不命中。
  /\brm\s+(?:--?[a-zA-Z-]+\s+)*(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?:\s+-{1,2}[a-zA-Z-]+)*\s+\/(?:\s|$)/,
  /\bsudo\s+rm\b/, /\bmkfs\b/,
  /\bdd\s+if=.*of=\/dev\//, /\bcurl\b.*\|\s*(ba)?sh\b/,
  />\s*\/etc\//,
]

/** 私钥与凭据类路径 — 连读取都不允许，内容一旦进模型上下文就等于泄露 */
export const FILE_NOWAY_PATTERNS: RegExp[] = [
  /\/\.ssh\//, /\.pem$/, /\.key$/,
]

/** 敏感但可由用户确认的路径 — 环境变量文件与系统目录 */
export const FILE_SENSITIVE_PATTERNS: RegExp[] = [
  /\/etc\/passwd/, /\/etc\/shadow/,
  /\/System\//, /\/Windows\//,
  /\.env$/,
]

/** 全部敏感路径模式。按子集并入，语义与拆分前一致，粗粒度断言仍然成立。 */
export const FILE_DANGEROUS_PATTERNS: RegExp[] = [
  ...FILE_NOWAY_PATTERNS,
  ...FILE_SENSITIVE_PATTERNS,
]

/** 检测文本是否匹配任一危险模式 */
export function matchesAnyPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(text))
}

/** 安全级别由低到高，用于合并「工具固有等级」与「本次调用的路径风险」。 */
const SAFETY_ORDER: SafetyLevel[] = ["SAFE", "NORMAL", "DANGER", "NOWAY"]

/** 取两个安全级别中更严的那个。 */
export function maxSafetyLevel(a: SafetyLevel, b: SafetyLevel): SafetyLevel {
  return SAFETY_ORDER.indexOf(a) >= SAFETY_ORDER.indexOf(b) ? a : b
}

/**
 * 按本次调用的路径解析文件风险等级。
 *
 * 这里是 `FILE_*_PATTERNS` 的生产接入点。此前它们只有测试消费者，
 * 于是 `pi-read` 以 SAFE 放行一切路径 —— `~/.ssh/id_rsa` 会被原样送进模型上下文。
 *
 * 返回 `SAFE` 表示「路径本身不额外提级」，由调用方与工具固有等级合并，
 * 因此这个函数可以单独用作只读工具的 `resolveSafetyLevel`。
 *
 * Windows 的反斜杠先归一成 `/`，否则同一份规则在两个平台表现不一致。
 */
export function resolveFilePathLevel(path: unknown): SafetyLevel {
  if (typeof path !== "string" || path.length === 0) return "SAFE"
  const normalized = path.replace(/\\/g, "/")
  if (matchesAnyPattern(normalized, FILE_NOWAY_PATTERNS)) return "NOWAY"
  if (matchesAnyPattern(normalized, FILE_SENSITIVE_PATTERNS)) return "DANGER"
  return "SAFE"
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

/** 按工具名整体信任 —— 只保留给单参调用，生产链路一律走调用级信任。 */
let sessionTrustedTools = new Set<string>()
/** 工具名 → 已确认过的调用签名。 */
let sessionTrustedCalls = new Map<string, Set<string>>()

/**
 * 会话信任的签名：本次调用的参数。
 *
 * 只按工具名记信任，等于把「确认一次」放大成「该工具本会话全免确认」——
 * `app_open` 确认过 A 路径之后，B 路径就不再询问。
 *
 * 用参数原样序列化而不是哈希：精确比较没有碰撞空间，
 * 而哈希碰撞在这里意味着「没确认过的调用被自动放行」。
 * 存储量由本会话的确认次数天然限制，不需要额外淘汰。
 */
export function trustSignature(params: Record<string, unknown>): string {
  return stableSerialize(params)
}

/**
 * 记录一次会话信任。
 *
 * 不传 `signature` 时按工具名整体信任；生产链路必须传签名。
 */
export function trustToolInSession(toolName: string, signature?: string): void {
  if (signature === undefined) {
    sessionTrustedTools.add(toolName)
    log.debug("会话信任 (整个工具):", toolName)
    return
  }
  const signatures = sessionTrustedCalls.get(toolName) ?? new Set<string>()
  signatures.add(signature)
  sessionTrustedCalls.set(toolName, signatures)
  log.debug("会话信任 (本次调用):", toolName)
}

/** 工具级信任与调用级信任任一命中即视为已信任 */
export function isToolTrusted(toolName: string, signature?: string): boolean {
  if (sessionTrustedTools.has(toolName)) return true
  return signature !== undefined && (sessionTrustedCalls.get(toolName)?.has(signature) ?? false)
}

/** 重置会话信任（新会话时调用） */
export function resetSessionTrust(): void {
  sessionTrustedTools = new Set()
  sessionTrustedCalls = new Map()
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
 *   NORMAL  → 首次确认后可按调用信任（sessionTrustEnabled=true 时）
 *   DANGER  → just_do_it 放行 / 同一份参数已确认则放行 / 否则确认
 *   NOWAY   → 硬拒绝
 *
 * 信任粒度是「工具 + 本次参数」，见 `trustSignature`；
 * let_me_tk 是最保守的模式，会话信任在它下面不参与。
 */
export function checkSafety(
  tool: ToolDef,
  params: Record<string, unknown>,
  ctx: ToolContext,
): SafetyCheckResult {
  const level = tool.resolveSafetyLevel?.(params, ctx) ?? tool.safetyLevel
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

      // 本次调用已确认过 → 跳过确认
      if (trustEnabled && isToolTrusted(tool.name, trustSignature(params))) {
        log.info("助手模式 NORMAL 放行 (本次调用已确认):", tool.name)
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
        if (tool.lightweightPolicy === "confirm") {
          log.info("轻量模式 DANGER 需要确认:", tool.name)
          return {
            allowed: true,
            needsConfirm: true,
            confirmMessage: `工具 "${tool.name}" 将修改文件或执行扩展命令，确认执行？`,
          }
        }
        log.info("轻量模式拒绝 DANGER:", tool.name)
        return {
          allowed: false,
          reason: "轻量模式不支持 DANGER 级别工具",
          personalityMessage: "这个功能需要在助手模式下使用哦～",
        }
      }

      // 助手模式 DANGER
      // just_do_it → 不确认，直接放行
      if (safetyMode === "just_do_it") {
        log.warn("助手模式 DANGER 放行 (just_do_it):", tool.name)
        return { allowed: true }
      }

      const dangerConfirm = {
        allowed: true,
        needsConfirm: true,
        confirmMessage: `⚠️ "${tool.name}" 是高风险操作！确认执行？`,
      }

      // let_me_tk 是最保守的模式：DANGER 每次都重新确认，会话信任不参与
      if (safetyMode === "let_me_tk") {
        log.warn("助手模式 DANGER 需要确认 (let_me_tk):", tool.name)
        return dangerConfirm
      }

      // 同一份参数已经被确认过 → 不再重复询问；换一组参数会重新确认
      if (trustEnabled && isToolTrusted(tool.name, trustSignature(params))) {
        log.info("助手模式 DANGER 放行 (本次调用已确认):", tool.name)
        return { allowed: true }
      }

      // tell_me → 首次确认
      log.warn("助手模式 DANGER 需要确认:", tool.name)
      return dangerConfirm
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

