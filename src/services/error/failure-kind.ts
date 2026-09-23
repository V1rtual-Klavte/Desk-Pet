// ==========================================
// 失败分类 —— 唯一定义点
//
// 生产回合失败（`engine/pi/runtime.ts` 的 `classifyTurnFailure` 由本文件 re-export）与
// Live Test 的场景失败分类共用本模块；不得在别处复制正则表。
// ==========================================

/**
 * 失败分类。
 *
 * `admission` 不是从文案派生的档位：它由调用点写入（回合准入拒绝、lane 结构操作在飞），
 * 分类函数永不返回它。其余档位与 Live Test 的 `ErrorKind` 同词表。
 */
export type FailureKind =
  | "timeout" | "auth" | "rate_limit" | "network" | "provider" | "admission" | "unknown"

/**
 * 把 Provider 的失败文案收敛成稳定分类。
 *
 * 状态码必须按**独立数字**匹配（`\b`）：HTTP 状态码在文案里前后一定不是数字，而本仓
 * 预算判定这类本地文案带的是估算 token 数那样的长数字串。无边界的老写法会让
 * `130523` 里的 `523`、`104031` 里的 `403`、`142900` 里的 `429` 命中，
 * 把本地预算失败记成 provider / auth / rate_limit —— 数字的形态因此污染了分类。
 *
 * 分类只能从文案反推：Harness 把运行失败降维成一条 message，没有结构化状态码通道
 * （记录里的 `code` 只有 assistant_error 一档），所以边界必须在这里钉死。
 * 稳定性由 Live Test 的 `预算溢出判定`（caseId `memory-budget-overflow-classification`，
 * 契约 `mm-22`，8 条 `samples`）与 `预算溢出恢复` 两处断言钉住。
 */
export function classifyFailureKind(message: string): FailureKind {
  const lower = message.toLowerCase()
  if (/timeout|timed out|超时/.test(lower)) return "timeout"
  if (/\b401\b|\b403\b|unauthor|invalid api key|api key/.test(lower)) return "auth"
  if (/\b429\b|rate limit|too many requests/.test(lower)) return "rate_limit"
  if (/enotfound|econnrefused|econnreset|network|fetch failed|dns/.test(lower)) return "network"
  if (/\b5\d\d\b|upstream|service unavailable|provider/.test(lower)) return "provider"
  return "unknown"
}
