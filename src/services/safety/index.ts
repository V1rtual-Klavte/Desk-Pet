// ==========================================
// 安全控制 —— 统一导出
// ==========================================

export {
  BASH_DANGEROUS_PATTERNS,
  BASH_NOWAY_PATTERNS,
  FILE_DANGEROUS_PATTERNS,
  FILE_NOWAY_PATTERNS,
  FILE_SENSITIVE_PATTERNS,
  matchesAnyPattern,
  maxSafetyLevel,
  resolveFilePathLevel,
} from "./checker"

export {
  authorizeToolExecution,
  awaitPermission,
  evaluateToolPermission,
  freezePermissionPolicy,
  invalidatePermissionScope,
} from "./permission"
export type { PermissionConfirmation, PermissionContext, PermissionPolicySnapshot, PermissionRequest, PermissionResult } from "./permission"
export type { PermissionDecision, ToolCheckResult, EffectClass } from "@/services/tool/types"

export { confirmState, requestPermissionConfirm, resolveConfirm, resolvePermissionConfirm } from "./confirm"
export type { ConfirmRequest } from "./confirm"
