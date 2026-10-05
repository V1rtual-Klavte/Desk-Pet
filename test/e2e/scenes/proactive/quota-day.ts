/**
 * 主动配额记账日（E2E 专属 fixture，非场景文件）。
 *
 * 产品的每日配额来自主动档位表（中档 dailyExpressionAttempts=12、dailySuccess=6；
 * 唯一真相源是 src/services/proactive/protocol.json 的 tiers.proactive，CONFIG
 * ai.proactive.frequency 选档），按 `localDate` 记在共享的隔离 SQLite 里，
 * 是跨场景、跨 trial 的真实防打扰行为：repeat>1 时同一场景的后续 trial
 * （以及后跑的主动场景）必然撞 daily_limit —— 那是产品正确行为，不是缺陷，
 * 测试要为每个 setup 提供未用过的配额域。
 *
 * 计数在模块单例里递增：同一 app 运行内所有使用它的场景各拿独立的未来记账日，
 * 场景执行顺序变化也不会把两个 setup 塞回同一天。日期只是产品的记账键
 * （Rust 侧仅校验 YYYY-MM-DD 形状），用 UTC 日推进保证严格单调、不受 DST 影响。
 */
let offset = 0

export function nextProactiveQuotaDay(): string {
  offset += 1
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
}
