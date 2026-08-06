// ==========================================
// 变量状态系统 — 四类变量（system/card/interaction/session）
// §5: 注册表驱动 + 持久化拆分 + 更新闭环
// ==========================================

import { createLogger } from "@/services/logger"
import type { CardVariableDef, VariableState, VariableType, VariablePrimitive } from "./types"

const log = createLogger("VarPool")

export interface VariablePool {
  system: Record<string, number | string | boolean>
  /** card 变量存储 VariableState 对象（与持久化同格式） */
  card: Record<string, VariableState>
  /** interaction 变量存储 VariableState 对象（与持久化同格式） */
  interaction: Record<string, VariableState>
  session: Record<string, number | string | boolean>
}

/** 持久化格式：vars.json (system-only) */
interface PersistedSystemVars {
  schemaVersion: number
  system: Record<string, number | string | boolean>
  updatedAt: number
}

/** 持久化格式：stages/{cardId}.json (card + interaction)
 *  标准格式：VariableState 对象 { value, type, updatedAt, updatedBy } */
interface PersistedCardVars {
  schemaVersion: number
  updatedAt: number
  card: Record<string, VariableState>
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
let pool: VariablePool = { system: {}, card: {}, interaction: {}, session: {} }
let savePending = false

/** 会话开始时间（用于 reset=session 判断） */
let sessionStartMs: number = Date.now()

export function setSessionStart(ts: number): void {
  sessionStartMs = ts
}

export function getSessionStart(): number {
  return sessionStartMs
}

// ── 快照/调试 ──

export interface VariablePoolRuntimeState {
  currentCardId: string | null
  pool: VariablePool
  savePending: boolean
}

export function snapshotVariablePoolState(): VariablePoolRuntimeState {
  return {
    currentCardId,
    pool: { system: { ...pool.system }, card: { ...pool.card }, interaction: { ...pool.interaction }, session: { ...pool.session } },
    savePending,
  }
}

export function restoreVariablePoolState(state: VariablePoolRuntimeState): void {
  currentCardId = state.currentCardId
  pool = {
    system: { ...state.pool.system },
    card: { ...state.pool.card },
    interaction: { ...state.pool.interaction },
    session: { ...state.pool.session },
  }
  savePending = state.savePending
}

// ── 辅助 ──

function emptyPool(): VariablePool {
  return { system: {}, card: {}, interaction: {}, session: {} }
}

// ── 初始化 ──

export interface InitPoolInput {
  cardId: string
  variableDefs: CardVariableDef[]
  /** 之前持久化的 card 变量状态（从 stages/{cardId}.json 恢复，VariableState 格式） */
  prevCardStates?: Record<string, VariableState>
  /** 之前持久化的 interaction 变量状态 */
  prevInteractionStates?: Record<string, VariableState>
}

export function initVariablePool(input: InitPoolInput): VariablePool {
  currentCardId = input.cardId
  registry = input.variableDefs

  // 系统变量
  const sysVars = computeSystemVariables(new Date(), input.cardId)
  pool.system = sysVars

  // Card 变量 — 优先从持久化恢复，否则用 initial
  const cardVars: Record<string, VariableState> = {}
  const cardDefs = registry.filter(d => d.scope === "card")
  for (const def of cardDefs) {
    const prev = input.prevCardStates?.[def.name]
    if (prev && validateVarAgainstDef(prev, def)) {
      cardVars[def.name] = prev
    } else {
      cardVars[def.name] = { value: def.initial, type: def.type, updatedAt: Date.now(), updatedBy: "system" }
    }
  }
  pool.card = cardVars

  // Interaction 变量
  const interactionVars: Record<string, VariableState> = {}
  const interactionDefs = registry.filter(d => d.scope === "interaction")
  for (const def of interactionDefs) {
    const prev = input.prevInteractionStates?.[def.name]
    if (prev && validateVarAgainstDef(prev, def)) {
      interactionVars[def.name] = prev
    } else {
      interactionVars[def.name] = { value: def.initial, type: def.type, updatedAt: Date.now(), updatedBy: "system" }
    }
  }
  pool.interaction = interactionVars
  pool.session = {}

  savePending = true
  log.info("变量池初始化:", currentCardId, "| system:", Object.keys(sysVars).length, "| card:", Object.keys(cardVars).length, "| interaction:", Object.keys(interactionVars).length)
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

/** 上次 daily reset 的日期键（用于 reset=daily 去重） */
let lastDailyResetKey = getDateKey(new Date())

function getDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

/**
 * 应用 reset 策略（每轮 Agent Loop 开始前调用）
 * - reset=daily: 本地日期变化后重置为 initial
 * - reset=session: 新会话开始时重置为 initial
 */
export function applyResetPolicies(now: Date, isNewSession: boolean): string[] {
  const resetVars: string[] = []
  const todayKey = getDateKey(now)

  for (const def of registry) {
    if (def.scope !== "card" || def.reset === "never") continue

    let shouldReset = false
    if (def.reset === "session" && isNewSession) shouldReset = true
    if (def.reset === "daily" && todayKey !== lastDailyResetKey) shouldReset = true

    if (shouldReset && def.name in pool.card) {
      pool.card[def.name] = { value: def.initial, type: def.type, updatedAt: Date.now(), updatedBy: "system" }
      savePending = true
      resetVars.push(def.name)
    }
  }

  // 更新 daily reset 追踪日期
  if (todayKey !== lastDailyResetKey) {
    lastDailyResetKey = todayKey
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
    session: { ...pool.session },
  }
}

export function getVariableRegistry(): CardVariableDef[] {
  return registry
}

// ── Prompt 格式化 ──

export function formatPoolForPrompt(snapshot?: VariablePool): string {
  const p = snapshot ?? pool
  const lines: string[] = []

  // [系统变量 - 只读]
  const sysParts = Object.entries(p.system)
    .map(([k, v]) => `${k}=${formatVal(v)}`)
  lines.push(`[系统变量 - 只读]\n${sysParts.join(", ") || "(空)"}`)

  // [Card变量 - 仅允许通过 RUNTIME_DATA 更新]
  const cardDefMap = new Map(registry.filter(d => d.scope === "card").map(d => [d.name, d]))
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
      const def = registry.find(d => d.scope === "interaction" && d.name === k)
      return `${k}=${formatVal((v as VariableState).value)}${def ? ` (${def.type}, updateBy=${def.updateBy}): ${def.description}` : ""}`
    })
  if (intParts.length > 0) {
    lines.push(`[互动状态 - 系统维护，只读]\n${intParts.join("\n")}`)
  }

  // [会话状态 - 只读]
  const sessParts = Object.entries(p.session)
    .map(([k, v]) => `${k}=${formatVal(v)}`)
  if (sessParts.length > 0) {
    lines.push(`[会话状态 - 只读]\n${sessParts.join(", ")}`)
  }

  return lines.join("\n\n")
}

function formatVal(v: unknown): string {
  return typeof v === "string" ? `"${v}"` : String(v)
}

// ── 系统更新 Interaction ──

export function updateInteractionVar(name: string, value: VariablePrimitive): { success: boolean; error?: string } {
  const def = registry.find(d => d.scope === "interaction" && d.name === name)
  if (!def) {
    return { success: false, error: `Interaction 变量 ${name} 未在 Card 中注册` }
  }
  if (def.updateBy !== "system") {
    return { success: false, error: `Interaction 变量 ${name} 的 updateBy 不是 system` }
  }
  // 校验类型
  if (typeof value !== def.type) {
    if (def.type === "number" && typeof value === "string") {
      const n = parseFloat(value)
      if (isNaN(n)) return { success: false, error: `类型不匹配: 期望 ${def.type}` }
      value = n
    } else {
      return { success: false, error: `类型不匹配: 期望 ${def.type}` }
    }
  }
  // number 范围校验
  if (def.type === "number" && typeof value === "number") {
    if (def.min !== undefined && value < def.min) return { success: false, error: `${name} 不能低于 ${def.min}` }
    if (def.max !== undefined && value > def.max) return { success: false, error: `${name} 不能超过 ${def.max}` }
  }

  pool.interaction[name] = { value: value as VariablePrimitive, type: def.type, updatedAt: Date.now(), updatedBy: "system" }
  savePending = true
  log.debug("interaction update:", name, "=", value)
  return { success: true }
}

// ── Session 变量注入 ──

export function setSessionVars(vars: Record<string, number | string | boolean>): void {
  pool.session = { ...vars }
}

// ── 持久化 ──

async function readFile(path: string): Promise<Uint8Array | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    const raw = await invoke<number[]>("personality_file_read", { path })
    return new Uint8Array(raw)
  } catch { return null }
}

async function writeFile(path: string, content: Uint8Array): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core")
  await invoke("personality_file_write", { path, content: Array.from(content) })
}

/** 持久化 system → vars.json, card+interaction → stages/{cardId}.json */
export async function saveVariablePoolAsync(
  writeFileExternal: (path: string, content: Uint8Array) => Promise<void>,
): Promise<void> {
  if (!savePending || !currentCardId) return

  const encoder = new TextEncoder()

  // 1. 写 vars.json（system only）
  const sysData: PersistedSystemVars = {
    schemaVersion: 2,
    system: { ...pool.system },
    updatedAt: Date.now(),
  }
  try {
    await writeFileExternal("personality/vars.json", encoder.encode(JSON.stringify(sysData, null, 2)))
  } catch (e) {
    log.warn("vars.json 持久化失败:", e)
    // 继续尝试保存 stages 文件，不因 vars.json 失败而跳过
  }

  // 2. 写 stages/{cardId}.json（保留 stages，更新 variables）
  try {
    const path = `personality/stages/${currentCardId}.json`
    const existingRaw = await readFile(path)
    let existing: Record<string, unknown> = {}
    if (existingRaw) {
      try { existing = JSON.parse(new TextDecoder().decode(existingRaw)) } catch { /* new file */ }
    }

    const varData: PersistedCardVars = {
      schemaVersion: 2,
      updatedAt: Date.now(),
      card: pool.card,
      interaction: pool.interaction,
    }
    const merged = { ...existing, variables: varData }
    await writeFileExternal(path, encoder.encode(JSON.stringify(merged, null, 2)))

    savePending = false
    log.debug("变量池已持久化:", path)
  } catch (e) {
    log.warn("stages 变量持久化失败:", e)
    savePending = false  // ★ 关键：防止卡死
  }
}

/** 严格持久化（失败抛错给事务回滚） */
export async function saveVariablePoolStrict(
  writeFileExternal: (path: string, content: Uint8Array) => Promise<void>,
): Promise<void> {
  if (!savePending || !currentCardId) return

  const encoder = new TextEncoder()

  const sysData: PersistedSystemVars = {
    schemaVersion: 2,
    system: { ...pool.system },
    updatedAt: Date.now(),
  }
  await writeFileExternal("personality/vars.json", encoder.encode(JSON.stringify(sysData, null, 2)))

  const path = `personality/stages/${currentCardId}.json`
  const existingRaw = await readFile(path)
  let existing: Record<string, unknown> = {}
  if (existingRaw) {
    try { existing = JSON.parse(new TextDecoder().decode(existingRaw)) } catch { /* new */ }
  }

  const varData: PersistedCardVars = {
    schemaVersion: 2,
    updatedAt: Date.now(),
    card: pool.card,
    interaction: pool.interaction,
  }
  const merged = { ...existing, variables: varData }
  await writeFileExternal(path, encoder.encode(JSON.stringify(merged, null, 2)))

  savePending = false
  log.debug("变量池已持久化(strict):", path)
}

/** 便捷：通过 Tauri invoke 持久化 */
export async function savePoolToDisk(): Promise<void> {
  await saveVariablePoolAsync(writeFile)
}

/** 便捷：严格持久化 */
export async function savePoolToDiskStrict(): Promise<void> {
  await saveVariablePoolStrict(writeFile)
}

// ── 从磁盘读取 ──

/** 读取 stages/{cardId}.json 中的变量状态 */
export async function loadCardVars(
  cardId: string,
): Promise<{ card: Record<string, VariableState>; interaction: Record<string, VariableState> } | null> {
  try {
    const raw = await readFile(`personality/stages/${cardId}.json`)
    if (!raw) return null
    const data = JSON.parse(new TextDecoder().decode(raw))
    const vars = data.variables as Record<string, unknown> | undefined
    if (!vars || (vars.schemaVersion as number) < 1) return null
    return {
      card: (vars.card || {}) as Record<string, VariableState>,
      interaction: (vars.interaction || {}) as Record<string, VariableState>,
    }
  } catch (e) {
    log.warn(`stages JSON 损坏, cardId=${cardId}`, e instanceof Error ? e.message : String(e))
    return null
  }
}

/** 读取 vars.json（system snapshot, 给设置页等使用） */
export async function readSystemVars(): Promise<Record<string, number | string | boolean> | null> {
  try {
    const raw = await readFile("personality/vars.json")
    if (!raw) return null
    const data = JSON.parse(new TextDecoder().decode(raw)) as PersistedSystemVars
    if (data.schemaVersion >= 1) return data.system
    return null
  } catch {
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
}
