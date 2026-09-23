// ==========================================
// 变量状态系统 — 三类变量（system/card/interaction）
// §5: 注册表驱动 + 持久化收敛到 stages 文件变量区 + 更新闭环
// ==========================================

import { createLogger } from "@/services/logger"
import type { CardVariableDef, VariableState, VariableType, VariablePrimitive } from "./types"
import { formatError } from "@/services/error"
import { readStagesFile, updateStagesFile, STAGES_FILE_SCHEMA_VERSION } from "./stages-file"
import type { StageFileVariables } from "./stages-file"

const log = createLogger("VarPool")

export interface VariablePool {
  system: Record<string, number | string | boolean>
  /** card 变量存储 VariableState 对象（与持久化同格式） */
  card: Record<string, VariableState>
  /** interaction 变量存储 VariableState 对象（与持久化同格式） */
  interaction: Record<string, VariableState>
}

// ── 系统变量定义（6 个）──

const SYSTEM_VAR_DEFS: Array<{
  name: string; type: VariableType
  compute: (now: Date) => number | string | boolean
}> = [
  { name: "hour", type: "number", compute: (n) => n.getHours() },
  { name: "minute", type: "number", compute: (n) => n.getMinutes() },
  { name: "dayOfWeek", type: "number", compute: (n) => n.getDay() },
  { name: "isNightTime", type: "boolean", compute: (n) => n.getHours() >= 22 || n.getHours() <= 5 },
  { name: "isWeekend", type: "boolean", compute: (n) => n.getDay() === 0 || n.getDay() === 6 },
]

// ── 内部状态 ──

let registry: CardVariableDef[] = []
let currentCardId: string | null = null
let pool: VariablePool = { system: {}, card: {}, interaction: {} }
let savePending = false

/** reset: "daily" 的「已应用」日期键；null = 尚无记录（升级前数据或首次激活） */
let lastDailyResetKey: string | null = null
/** reset: "session" 的「已应用」会话键（SessionMeta.createdAt）；null = 尚无记录 */
let appliedSessionKey: number | null = null
/** interaction 写入被拒的去重键（`cardId:name:reason`），避免同一原因每轮回放刷日志 */
const rejectedInteractionKeys = new Set<string>()

// ── 快照/调试 ──

export interface VariablePoolRuntimeState {
  currentCardId: string | null
  /** 注册表必须一起快照：只回滚池会让后续写入按错 schema 校验（VAR-02） */
  registry: CardVariableDef[]
  pool: VariablePool
  savePending: boolean
  lastDailyResetKey: string | null
  appliedSessionKey: number | null
}

export function snapshotVariablePoolState(): VariablePoolRuntimeState {
  return {
    currentCardId,
    registry: [...registry],
    pool: { system: { ...pool.system }, card: { ...pool.card }, interaction: { ...pool.interaction } },
    savePending,
    lastDailyResetKey,
    appliedSessionKey,
  }
}

export function restoreVariablePoolState(state: VariablePoolRuntimeState): void {
  currentCardId = state.currentCardId
  registry = [...state.registry]
  pool = {
    system: { ...state.pool.system },
    card: { ...state.pool.card },
    interaction: { ...state.pool.interaction },
  }
  savePending = state.savePending
  lastDailyResetKey = state.lastDailyResetKey
  appliedSessionKey = state.appliedSessionKey
}

// ── 辅助 ──

function emptyPool(): VariablePool {
  return { system: {}, card: {}, interaction: {} }
}

// ── 初始化 ──

export interface InitPoolInput {
  cardId: string
  variableDefs: CardVariableDef[]
  /** 之前持久化的 card 变量状态（从 stages/{cardId}.json 恢复，VariableState 格式） */
  prevCardStates?: Record<string, VariableState>
  /** 之前持久化的 interaction 变量状态 */
  prevInteractionStates?: Record<string, VariableState>
  /** reset: "daily" 的已应用日期键（来自文件 variables 段） */
  lastDailyResetKey?: string
  /** reset: "session" 的已应用会话键（SessionMeta.createdAt） */
  sessionKey?: number
}

/** 纯函数：按 defs + 上次状态构建池，不触碰任何模块状态（VAR-E1 的生产入口） */
export function buildPoolFromDefs(input: InitPoolInput): VariablePool {
  const card: Record<string, VariableState> = {}
  for (const def of input.variableDefs) {
    if (def.scope !== "card") continue
    const prev = input.prevCardStates?.[def.name]
    card[def.name] = prev && validateVarAgainstDef(prev, def)
      ? prev
      : { value: def.initial, type: def.type, updatedAt: Date.now(), updatedBy: "system" }
  }

  const interaction: Record<string, VariableState> = {}
  for (const def of input.variableDefs) {
    if (def.scope !== "interaction") continue
    const prev = input.prevInteractionStates?.[def.name]
    interaction[def.name] = prev && validateVarAgainstDef(prev, def)
      ? prev
      : { value: def.initial, type: def.type, updatedAt: Date.now(), updatedBy: "system" }
  }

  return { system: computeSystemVariables(new Date(), input.cardId), card, interaction }
}

export function initVariablePool(input: InitPoolInput): VariablePool {
  currentCardId = input.cardId
  registry = input.variableDefs
  // 游标从文件恢复；缺失即「从未应用过」（见 applyResetPolicies 的两条语义）
  lastDailyResetKey = input.lastDailyResetKey ?? null
  appliedSessionKey = input.sessionKey ?? null

  pool = buildPoolFromDefs(input)
  savePending = true
  log.info("变量池初始化:", currentCardId, "| system:", Object.keys(pool.system).length, "| card:", Object.keys(pool.card).length, "| interaction:", Object.keys(pool.interaction).length)
  return getPoolSnapshot()
}

/** 校验持久化值是否符合变量注册表定义 */
function validateVarAgainstDef(state: VariableState, def: CardVariableDef): boolean {
  if (state.type !== def.type) return false
  switch (def.type) {
    case "number": {
      if (typeof state.value !== "number") return false
      if (def.min !== undefined && state.value < def.min) return false
      if (def.max !== undefined && state.value > def.max) return false
      return true
    }
    case "string": {
      if (typeof state.value !== "string") return false
      if (def.enum && !def.enum.includes(state.value)) return false
      return true
    }
    case "boolean":
      return typeof state.value === "boolean"
  }
}

// ── 系统变量计算 ──

export function computeSystemVariables(now: Date, activeCardId: string): Record<string, number | string | boolean> {
  const vars: Record<string, number | string | boolean> = {}
  for (const def of SYSTEM_VAR_DEFS) {
    vars[def.name] = def.compute(now)
  }
  vars.activeCardId = activeCardId
  return vars
}

// ── 刷新（每轮 Agent Loop 开始）──

export interface RefreshInput {
  activeCardId?: string
}

export function refreshVariablePool(input: RefreshInput = {}): VariablePool {
  const cardId = input.activeCardId ?? currentCardId ?? ""
  pool.system = computeSystemVariables(new Date(), cardId)
  return getPoolSnapshot()
}

// ── Reset 策略 ──

function getDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

/**
 * 应用 reset 策略（每轮 Agent Loop 开始前调用）
 *
 * - daily：注册表确实含 daily 变量且 `lastDailyResetKey !== todayKey` 才推进游标 + 重置；
 *   持久化字段缺失（升级前数据）等于 null → 视为陈旧、重置一次（daily 语义允许）。
 * - session：`sessionKey === null` 时不做判定（不能凭空认定新会话）；
 *   非 null 且与 `appliedSessionKey` 不同才重置。
 * - 游标推进本身即 `savePending = true`（游标是该 Card variables 段的一部分）。
 */
export function applyResetPolicies(now: Date, sessionKey: number | null): string[] {
  const resetVars: string[] = []
  const todayKey = getDateKey(now)

  const dailyDue = registry.some(d => d.scope === "card" && d.reset === "daily") && todayKey !== lastDailyResetKey
  const sessionDue = sessionKey !== null && sessionKey !== appliedSessionKey

  if (dailyDue || sessionDue) {
    for (const def of registry) {
      if (def.scope !== "card" || def.reset === "never") continue

      let shouldReset = false
      if (def.reset === "daily" && dailyDue) shouldReset = true
      if (def.reset === "session" && sessionDue) shouldReset = true

      if (shouldReset && def.name in pool.card) {
        pool.card[def.name] = { value: def.initial, type: def.type, updatedAt: Date.now(), updatedBy: "system" }
        savePending = true
        resetVars.push(def.name)
      }
    }
  }

  // 游标只在真的换日时推进：无 daily 变量则不产生无谓写盘
  if (dailyDue) {
    lastDailyResetKey = todayKey
    savePending = true
  }
  if (sessionDue && sessionKey !== null) {
    appliedSessionKey = sessionKey
    savePending = true
  }

  if (resetVars.length > 0) {
    log.info("reset 策略触发:", resetVars.join(", "))
  }
  return resetVars
}

// ── 快照（只读视图）──

export function getPoolSnapshot(): VariablePool {
  return {
    system: { ...pool.system },
    card: { ...pool.card },
    interaction: { ...pool.interaction },
  }
}

export function getVariableRegistry(): CardVariableDef[] {
  return registry
}

// ── Prompt 格式化 ──

/**
 * 序列化变量池为 Prompt 文本。
 * `defs` 显式传入时按它取变量元数据 —— 预览非激活 Card 时必须传，
 * 否则元数据来自活动卡注册表（VAR-E1 的第二处）。
 */
export function formatPoolForPrompt(snapshot?: VariablePool, defs?: CardVariableDef[]): string {
  const p = snapshot ?? pool
  const defs0 = defs ?? registry
  const lines: string[] = []

  // [系统变量 - 只读]
  const sysParts = Object.entries(p.system)
    .map(([k, v]) => `${k}=${formatVal(v)}`)
  lines.push(`[系统变量 - 只读]\n${sysParts.join(", ") || "(空)"}`)

  // [Card变量 - 仅允许通过 RUNTIME_DATA 更新]
  const cardDefMap = new Map(defs0.filter(d => d.scope === "card").map(d => [d.name, d]))
  const cardParts: string[] = []
  for (const [name, state] of Object.entries(p.card)) {
    const def = cardDefMap.get(name)
    const meta = def
      ? ` (${def.type}${def.enum ? `, enum: ${def.enum.join("/")}` : ""}${def.min !== undefined ? `, ${def.min}..${def.max ?? ""}` : ""}, updateBy=${def.updateBy}): ${def.description}`
      : ""
    cardParts.push(`${name}=${formatVal((state as VariableState).value)}${meta}`)
  }
  lines.push(`[Card变量 - 仅允许通过 RUNTIME_DATA 更新]\n${cardParts.join("\n") || "(空)"}`)

  // [互动状态 - 系统维护，只读]
  const intParts = Object.entries(p.interaction)
    .map(([k, v]) => {
      const def = defs0.find(d => d.scope === "interaction" && d.name === k)
      return `${k}=${formatVal((v as VariableState).value)}${def ? ` (${def.type}, updateBy=${def.updateBy}): ${def.description}` : ""}`
    })
  if (intParts.length > 0) {
    lines.push(`[互动状态 - 系统维护，只读]\n${intParts.join("\n")}`)
  }

  return lines.join("\n\n")
}

function formatVal(v: unknown): string {
  return typeof v === "string" ? `"${v}"` : String(v)
}

// ── 系统更新 Interaction ──

/** 拒绝分支统一出口：按 (cardId, name, reason) 去重后 log.warn（VAR-08） */
function rejectInteractionWrite(name: string, reason: string, message: string): { success: boolean; error: string } {
  const key = `${currentCardId ?? "?"}:${name}:${reason}`
  if (!rejectedInteractionKeys.has(key)) {
    rejectedInteractionKeys.add(key)
    log.warn("interaction 写入被拒:", key, message)
  }
  return { success: false, error: message }
}

export function updateInteractionVar(name: string, value: VariablePrimitive): { success: boolean; error?: string } {
  const def = registry.find(d => d.scope === "interaction" && d.name === name)
  if (!def) {
    return rejectInteractionWrite(name, "未注册", `Interaction 变量 ${name} 未在 Card 中注册`)
  }
  if (def.updateBy !== "system") {
    return rejectInteractionWrite(name, "updateBy 不是 system", `Interaction 变量 ${name} 的 updateBy 不是 system`)
  }
  // 校验类型
  if (typeof value !== def.type) {
    if (def.type === "number" && typeof value === "string") {
      const n = parseFloat(value)
      if (isNaN(n)) return rejectInteractionWrite(name, "类型不匹配", `类型不匹配: 期望 ${def.type}`)
      value = n
    } else {
      return rejectInteractionWrite(name, "类型不匹配", `类型不匹配: 期望 ${def.type}`)
    }
  }
  // number 范围校验
  if (def.type === "number" && typeof value === "number") {
    if (def.min !== undefined && value < def.min) return rejectInteractionWrite(name, "低于 min", `${name} 不能低于 ${def.min}`)
    if (def.max !== undefined && value > def.max) return rejectInteractionWrite(name, "超过 max", `${name} 不能超过 ${def.max}`)
  }

  pool.interaction[name] = { value: value as VariablePrimitive, type: def.type, updatedAt: Date.now(), updatedBy: "system" }
  savePending = true
  log.debug("interaction update:", name, "=", value)
  return { success: true }
}

// ── 持久化 ──
// 唯一落点 = stages/{cardId}.json 的 variables 段（经 stages-file 的 updateStagesFile）。
// 两条路径的失败语义不同：async 只留痕不抛（回合后处理不该因写盘失败中断）；
// strict 抛出，交回事务回滚。

/** variables 段的唯一形态 —— 与 stages-cache 的 stages 段共享一个文件与一次合并写 */
function buildVariablesSection(): StageFileVariables {
  return {
    schemaVersion: STAGES_FILE_SCHEMA_VERSION,
    updatedAt: Date.now(),
    card: { ...pool.card },
    interaction: { ...pool.interaction },
    // 游标只在有记录时写字段：缺失即「从未应用过」，不是「今天已应用」
    ...(lastDailyResetKey !== null ? { lastDailyResetKey } : {}),
    ...(appliedSessionKey !== null ? { sessionKey: appliedSessionKey } : {}),
  }
}

/** 持久化（失败 log.warn，不抛） */
export async function saveVariablePoolAsync(): Promise<void> {
  if (!savePending || !currentCardId) return
  try {
    await updateStagesFile(currentCardId, { variables: buildVariablesSection() })
    savePending = false
    log.debug("变量池已持久化:", currentCardId)
  } catch (e) {
    log.warn("变量池持久化失败:", formatError(e))
    savePending = false  // ★ 关键：防止卡死
  }
}

/** 严格持久化（失败抛出给事务回滚） */
export async function saveVariablePoolStrict(): Promise<void> {
  if (!savePending || !currentCardId) return
  await updateStagesFile(currentCardId, { variables: buildVariablesSection() })
  savePending = false
  log.debug("变量池已持久化(strict):", currentCardId)
}

/** 便捷：唯一公开的保存入口（无参，写当前 Card 自己的 stages 文件） */
export async function savePoolToDisk(): Promise<void> {
  await saveVariablePoolAsync()
}

/** 便捷：严格持久化 */
export async function savePoolToDiskStrict(): Promise<void> {
  await saveVariablePoolStrict()
}

// ── 从磁盘读取 ──

/** 读取 stages/{cardId}.json 的变量区；不存在或不可用时返回 null（调用方按 Card 初始值重建） */
export async function loadCardVars(cardId: string): Promise<{
  card: Record<string, VariableState>
  interaction: Record<string, VariableState>
  lastDailyResetKey?: string
  sessionKey?: number
} | null> {
  try {
    const file = await readStagesFile(cardId)
    if (!file) return null

    const variables = file.variables
    // 首次激活也会命中这里一次（文件里只有 stages 段）。
    // 存量数据出现「有 stages 段却没有变量区」就是三个写入者互相抹除的现场证据。
    if (!variables || !(variables.schemaVersion >= 1)) {
      log.warn("stages 文件缺少变量区，按 Card 初始值重建:", cardId)
      return null
    }
    return {
      card: variables.card ?? {},
      interaction: variables.interaction ?? {},
      lastDailyResetKey: variables.lastDailyResetKey,
      sessionKey: variables.sessionKey,
    }
  } catch (e) {
    // readStagesFile 已就损坏留证；这里显式降级为「无变量区」，由调用方按 Card 初始值重建。
    log.error("变量区读取失败，按 Card 初始值重建:", cardId, formatError(e))
    return null
  }
}

// ── 批量写入 (RUNTIME_DATA 解析后调用) ──

function coerceValue(raw: string, def: CardVariableDef): number | string | boolean | undefined {
  const trimmed = raw.trim()
  switch (def.type) {
    case "boolean": {
      if (trimmed === "true") return true
      if (trimmed === "false") return false
      return undefined
    }
    case "number": {
      const num = parseFloat(trimmed)
      if (isNaN(num)) return undefined
      if (def.min !== undefined && num < def.min) return undefined
      if (def.max !== undefined && num > def.max) return undefined
      return num
    }
    case "string": {
      const unquoted = ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
        ? trimmed.slice(1, -1)
        : trimmed
      if (def.enum && !def.enum.includes(unquoted)) return undefined
      return unquoted
    }
  }
}

export function batchWriteVars(updates: Record<string, string>): { written: string[]; errors: string[] } {
  const written: string[] = []
  const errors: string[] = []

  for (const [name, rawValue] of Object.entries(updates)) {
    const def = registry.find(d => d.scope === "card" && d.name === name)
    if (!def) { errors.push(`${name}: 未注册`); continue }
    if (def.updateBy !== "llm") { errors.push(`${name}: 不可写`); continue }

    const value = coerceValue(rawValue.trim(), def)
    if (value === undefined) { errors.push(`${name}: 类型/范围不符`); continue }

    pool.card[name] = { value, type: def.type, updatedAt: Date.now(), updatedBy: "llm" }
    savePending = true
    written.push(name)
  }

  if (written.length > 0) log.info("batchWrite:", written.join(", "))
  if (errors.length > 0) log.warn("batchWrite errors:", errors.join("; "))
  return { written, errors }
}

// ── 销毁 ──

export function destroyPool(): void {
  currentCardId = null
  registry = []
  pool = emptyPool()
  savePending = false
  lastDailyResetKey = null
  appliedSessionKey = null
  rejectedInteractionKeys.clear()
}
