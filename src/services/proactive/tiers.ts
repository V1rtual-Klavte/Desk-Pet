/**
 * 频率档位（关 / 低 / 中 / 高）：读取期收拢与档位值查表。
 *
 * 档位数值的单一真相源是 `PROACTIVE_LIMITS.tiers`（`protocol.json` 由
 * `scripts/generate-memory-protocol.mjs` 生成到 TS 与 Rust 两侧，不双写）。
 * 本模块只做「读 CONFIG 档位 → 收拢非法值 → 查表返回冻结常量」：
 * 纯函数、无副作用、不写盘、不加缓存（表本身是 frozen 常量）。
 *
 * 三处档位彼此独立 —— 主动消息（proactive）、静默了解（silent）、记忆整理（dreaming）。
 * `"off"` 的语义是「不自动跑」（手动入口保留），因此频率读取返回四值，而查表只接受三档
 * `ActiveTier`：调用方必须先判 `off` 再取表，避免把「关」当成频率用。
 */
import { isFrequencyTier, memoryConfig, proactiveConfig, silentAccessConfig } from "@/services/config"
import type { FrequencyTier } from "@/services/config"
import { PROACTIVE_LIMITS } from "./protocol"

// 档位类型与四值集合的单一真相源在 config 层（避免 config ↔ tiers 双向依赖成环）；
// 本模块只补「查表」与「纯函数收拢」，不另立一份值集。
export type { FrequencyTier }
export type ActiveTier = Exclude<FrequencyTier, "off">
/**
 * 档位行类型：键取自生成表，数值字段放宽为 number、钟点表（`hours`）放宽为只读数组 ——
 * 生成表是 `as const`，三档同名字段的字面量类型互不相同（如 wakeMinMs 为
 * 7200000/1800000/600000，hours 为长度不同的只读元组），不放宽就无法用同一个签名
 * 返回三行中的任意一行。
 */
type TierRowValue<Value> = Value extends readonly number[] ? readonly number[] : number
type TierRow<Row> = { readonly [Key in keyof Row]: TierRowValue<Row[Key]> }
export type ProactiveTierLimits = TierRow<typeof PROACTIVE_LIMITS.tiers.proactive.low>
export type SilentTierLimits = TierRow<typeof PROACTIVE_LIMITS.tiers.silent.low>
export type DreamingTierLimits = TierRow<typeof PROACTIVE_LIMITS.tiers.dreaming.low>

/**
 * 读取期收拢（CONFIG 是用户可手写的 YAML）：合法四值原样返回，其余（含缺失、类型不符）
 * 一律按保守默认 `"medium"` 读取；不写盘、不做旧值兼容映射 —— 与 `appearance.effectMode`
 * 的读取期规则同口径。诊断留在 config 层的 getter，本函数保持纯函数、不产生日志副作用；
 * 四值集合判定复用 config 层的 `isFrequencyTier`（单一真相源），本函数只补默认值。
 */
export function readFrequencyTier(value: unknown): FrequencyTier {
  return isFrequencyTier(value) ? value : "medium"
}

/** 主动消息档位（`ai.proactive.frequency`）。 */
export function proactiveFrequency(): FrequencyTier {
  return readFrequencyTier(proactiveConfig.frequency)
}

/** 静默了解档位（`ai.silentAccess.frequency`）。 */
export function silentAccessFrequency(): FrequencyTier {
  return readFrequencyTier(silentAccessConfig.frequency)
}

/** 记忆整理档位（`ai.memory.dreaming.tier`）。 */
export function dreamingTier(): FrequencyTier {
  return readFrequencyTier(memoryConfig.dreamingTier)
}

export function proactiveTierLimits(tier: ActiveTier): Readonly<ProactiveTierLimits> {
  return PROACTIVE_LIMITS.tiers.proactive[tier]
}

export function silentTierLimits(tier: ActiveTier): Readonly<SilentTierLimits> {
  return PROACTIVE_LIMITS.tiers.silent[tier]
}

export function dreamingTierLimits(tier: ActiveTier): Readonly<DreamingTierLimits> {
  return PROACTIVE_LIMITS.tiers.dreaming[tier]
}
