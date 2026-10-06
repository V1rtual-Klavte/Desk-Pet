/**
 * 主动场景时钟（E2E 专属 fixture，非场景文件；与 quota-day.ts 同属「主动重复隔离」）。
 *
 * 为什么需要：产品的表达冷却在 claim 上是**全局**最小间隔 —— `last_committed_expression_at`
 * (`proactive_occurrences` 全表 MAX) + 档位 `cooldownMs`（crates/native-host/src/proactive/
 * store.rs），按时间不按记账日或 occurrence 分行。前一个 trial 只要真的提交成功，后一个
 * trial 的 claim 就会落进冷却窗口被拒（`{"claimed":false,"reason":"cooldown"}`），表现为
 * 主动表达在 Provider 前被拦下、usage 全 0。那是产品正确行为，不是缺陷：repeat>1 的测试
 * 必须为每个 setup 提供**独立的时间域**，与 Rust 单测「now + cooldownMs + 1 再 claim」同款。
 *
 * 实现：真实时钟叠加一个每 setup 前进 `STEP_MS` 的固定偏移，只用于**门禁输入**
 * （scan / claim / validate 的 `now` 请求字段，计数在模块单例里递增、同一 run 内严格单调）。
 * - `STEP_MS` 必须大于最大档位 cooldownMs（low=15000，见 memory/protocol.rs 的
 *   `PROACTIVE_TIERS_*_COOLDOWN_MS`），取 30s 留 2 倍余量。
 * - 为什么是**超前**而不是回拨：`ProactiveSettleRequest` 没有 `now`（TS 协议不声明，
 *   settle 的落账时间由 Rust 侧真实 `now_ms()` 写），已提交时间戳始终是真实时间 ——
 *   门禁输入必须推到「上次真实提交 + cooldown」之后才放行。超前只存在于请求输入，
 *   不会给账本留下未来时间戳，后续场景的 claim 不被牵连。
 * - 约束：`now + 60_000`（场景侧 sourceRefs.validUntil 的惯用形状）必须仍大于真实墙钟 ——
 *   Rust 侧 `validate_source_ref`（card/behavior/variable/calendar 分支）用真实 `now_ms()`
 *   比对有效期；超前方向天然满足，无需特判。
 */
const STEP_MS = 30_000
let offsetMs = 0

/** 下一次 setup 的场景时钟（毫秒时间戳）；每次调用前进 STEP_MS。 */
export function nextProactiveNow(): number {
  offsetMs += STEP_MS
  return Date.now() + offsetMs
}
