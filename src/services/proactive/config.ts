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
export const DAY_MS = 86_400_000
export const MAX_FOLLOWUP_DAYS = 7
