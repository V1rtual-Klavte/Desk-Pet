/** Maximum lifetime for each explicitly sourced screen/file/window summary. */
export const OBSERVATION_SOURCE_TTL_MS = 7 * 24 * 60 * 60_000

/** How long topic evidence can affect content selection before it expires naturally. */
export const TOPIC_EVIDENCE_TTL_MS = 90 * 24 * 60 * 60_000

/**
 * 每小时读取名额的滚动窗口长度。名额上限本身由静默了解档位表提供
 * （`silentTierLimits(tier).maxReadsPerHour`，见 `proactive/tiers.ts`），不在这里写死第二份；
 * 记账是 understanding.json 里持久化的滚动时间戳：超限的本批跳过决策与读取，只保留截图。
 */
export const READ_WINDOW_MS = 60 * 60_000

/**
 * 喂给整理调用的单个文件内容上限（字符）：这是请求上下文的预算边界，
 * 不是「读取权限/读取大小」的数值上限（后者的 Rust 三处上限已随本轮终裁删除）。
 */
export const MAX_TEXT_CHARS_PER_FILE = 8_000

/** 审计字段里单条路径的截断长度。 */
export const MAX_AUDIT_PATH_CHARS = 240

/**
 * 话题整理单批的可负担 token 上限：这是本模块请求上下文的资源边界，不是频率档位值
 * （话题标签链不受三处档位治理）。此前借用主动链的顶层 dailyTokens（24000）；该常量
 * 随档位化收进 tiers 后，这里按本模块的批次边界自持同值，防四条长来源永久卡住队首。
 */
export const TOPIC_BATCH_TOKEN_CEILING = 24_000
