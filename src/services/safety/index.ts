// ==========================================
// 安全控制 —— 统一导出
// ==========================================

export {
  checkSafety,
  checkAll,
  trustToolInSession,
  isToolTrusted,
  resetSessionTrust,
  BASH_DANGEROUS_PATTERNS,
  BASH_NOWAY_PATTERNS,
  FILE_DANGEROUS_PATTERNS,
  matchesAnyPattern,
} from "./checker"
export type { SafetyCheckResult } from "./checker"

export { confirmState, requestConfirm, resolveConfirm } from "./confirm"
export type { ConfirmRequest } from "./confirm"
