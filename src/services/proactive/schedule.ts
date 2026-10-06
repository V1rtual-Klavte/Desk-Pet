/**
 * 钟点调度（静默了解 / 记忆整理共用）：固定钟点触发，不再要求系统空闲。
 *
 * 档位语义 = 每天的钟点数（低 2 / 中 4 / 高 6），钟点表的唯一真相源是
 * `proactive/protocol.json` 的 `tiers.silent` / `tiers.dreaming`（同为一张表，
 * 两域各自独立记账「该钟点是否已跑」）。钟点表本身就是每日轮数上限（`hours.length`），
 * 也是静默时段（23–9）的排除方式：表内不出现静默小时。
 *
 * 本模块是零依赖叶子，只做纯判定，不读 CONFIG、不写盘、不产生日志副作用。
 */

/** 钟点后的追赶窗口：睡眠唤醒、启动或链路抖动错过钟点时刻后仍算「到点」的上限。 */
export const SCHEDULE_CATCHUP_MS = 15 * 60_000

/**
 * 该钟点本轮是否到期（纯函数，注入 now / lastAttemptAt 便于单测）：
 *
 * - `now` 的本地时刻必须落在某个钟点 H 的 [H:00, H:00 + 15 分钟) 追赶窗口内
 *   （表里没有的钟点不触发；静默时段 23–9 不在任何档位的表内，天然排除）；
 * - 且 `lastAttemptAt` 早于该钟点起点 —— 本轮未跑过（同一钟点只跑一轮；
 *   尝试时刻在未来按「已跑」处理，失败向保守侧收拢）。
 */
export function scheduledSlotDue(hours: readonly number[], now: number, lastAttemptAt: number): boolean {
  const date = new Date(now)
  const hour = date.getHours()
  if (!hours.includes(hour)) return false
  // 当前本地钟点的起点：按分钟/秒/毫秒回退到整点，避免本地时区构造在 DST 切换日的偏移。
  const hourStart = now - (date.getMinutes() * 60_000 + date.getSeconds() * 1_000 + date.getMilliseconds())
  if (now - hourStart >= SCHEDULE_CATCHUP_MS) return false
  return lastAttemptAt < hourStart
}
