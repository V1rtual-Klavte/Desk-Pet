export { PROACTIVE_LIMITS } from "./protocol"
/** Frontend bounds, consumed by rules and their deadline/quality guards. */
export const OPPORTUNITY_LIMIT = 100
export const RECENT_TARGET_LIMIT = 2
export const OBSERVATION_MAX_AGE_MS = 15_000
export const WORK_SILENCE_MS = 30 * 60_000
export const FINISH_WORK_DELAY_MS = 10 * 60_000
export const PLANNING_TIMEOUT_MS = 90_000
export const PLANNING_OUTPUT_RESERVE = 800
export const SOURCE_CONTEXT_BUDGET = 1200
/** 规划子运行的工具调用预算（runPiSubAgent 的 maxRounds = 最多几次工具调用，含其后的回灌请求）。 */
export const PLANNING_TOOL_ROUNDS = 3
/**
 * 规划输入里 Card 人设摘要的 token 上限。
 * 预算依据：仓库默认 Card 的名字+描述+角色设定+语言风格约 379 token（`estimateContextTokens`
 * 口径，非 ASCII ≈1 token/字符）—— 400 覆盖主体且不截断出厂卡，又远小于整份 Card；
 * 输出规则、必须遵守与变量说明不进口（完整口吻约束由表达回合承担）。
 */
export const PLANNING_PERSONA_BUDGET = 400
/**
 * 规划输入里变量池只读摘要的 token 上限。
 * 预算依据：system 原始值约 5 项 + card/interaction 当前值，通常远小于该上限；
 * 上限只防 Card 注册大量变量时把规划输入撑爆
 * （formatPoolForPrompt 的逐变量说明文字不进口，见 planner.ts 的 poolSummary）。
 */
export const PLANNING_VARIABLE_BUDGET = 300
export const DAY_MS = 86_400_000
export const MAX_FOLLOWUP_DAYS = 7
