// ==========================================
// 安全控制 —— 统一导出
// ==========================================

export {
  checkSafety,
  trustToolInSession,
  isToolTrusted,
  resetSessionTrust,
  trustSignature,
  BASH_DANGEROUS_PATTERNS,
  BASH_NOWAY_PATTERNS,
  FILE_DANGEROUS_PATTERNS,
  FILE_NOWAY_PATTERNS,
  FILE_SENSITIVE_PATTERNS,
  matchesAnyPattern,
  maxSafetyLevel,
  resolveFilePathLevel,
} from "./checker"
export type { SafetyCheckResult } from "./checker"

export {
  authorizeToolExecution,
  awaitPermission,
  evaluateToolPermission,
  invalidatePermissionScope,
} from "./permission"
export type { PermissionConfirmation, PermissionContext, PermissionRequest, PermissionResult } from "./permission"
export type { PermissionDecision, ToolCheckResult, EffectClass } from "@/services/tool/types"

export { confirmState, requestConfirm, requestPermissionConfirm, resolveConfirm, resolvePermissionConfirm } from "./confirm"
export type { ConfirmRequest } from "./confirm"
