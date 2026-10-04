/** Maximum lifetime for each explicitly sourced screen/file/window summary. */
export const OBSERVATION_SOURCE_TTL_MS = 7 * 24 * 60 * 60_000

/** How long topic evidence can affect content selection before it expires naturally. */
export const TOPIC_EVIDENCE_TTL_MS = 90 * 24 * 60 * 60_000

/**
 * 静默了解的每小时读取上限（dev 可调模块常量，不进 UI/CONFIG）。
 * 记账是 understanding.json 里持久化的滚动时间戳：超限的本批跳过决策与读取，只保留截图。
 */
export const MAX_READS_PER_HOUR = 6

/** 上限的滚动窗口长度。 */
export const READ_WINDOW_MS = 60 * 60_000

/** 单批目标数上限；Rust 宿主侧同样拒绝超过该数的请求。 */
export const MAX_READ_TARGETS_PER_BATCH = 3

/** 喂给整理调用的单个文件内容上限（字符）；读取本身由 Rust 限到 32KB 字节。 */
export const MAX_TEXT_CHARS_PER_FILE = 8_000

/** 审计字段里单条路径的截断长度。 */
export const MAX_AUDIT_PATH_CHARS = 240
