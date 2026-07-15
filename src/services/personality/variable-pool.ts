// ==========================================
// 变量池系统 v2 — 四类变量（system/card/interaction/session）
// §5: 注册表驱动 + 持久化拆分 + 更新闭环
// ==========================================

import { createLogger } from "@/services/logger"
import type { CardVariableDef, VariableState, VariableType, VariablePrimitive } from "./types"
import type { StageVariables } from "./stages-cache"

const log = createLogger("VarPool")

// ── 类型 ──

export type VarType = "number" | "string" | "boolean"

export interface VarDef {
  name: string
  value: number | string | boolean
  source: "system" | "card" | "interaction" | "session"
  type: VarType
  updatedAt: number
  updatedBy?: "system" | "llm"
}

export interface VariablePool {
  system: Record<string, number | string | boolean>
  card: Record<string, number | string | boolean>
  interaction: Record<string, number | string | boolean>
  session: Record<string, number | string | boolean>
}

/** 持久化格式：vars.json (system-only) */
interface PersistedSystemVars {
  schemaVersion: number
  system: Record<string, number | string | boolean>
  updatedAt: number
}

/** 持久化格式：stages/{cardId}.json (card + interaction) */
interface PersistedCardVars {
  schemaVersion: number
  updatedAt: number
  card: Record<string, number | string | boolean>
  interaction: Record<string, number | string | boolean>
}

// ── 系统变量定义（6 个）──

const SYSTEM_VAR_DEFS: Array<{
  name: string; type: VarType
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
  /** 之前持久化的 card 变量状态（从 stages/{cardId}.json 恢复） */
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
  const cardVars: Record<string, number | string | boolean> = {}
  const cardDefs = registry.filter(d => d.scope === "card")
  for (const def of cardDefs) {
    const prev = input.prevCardStates?.[def.name]
    if (prev && validateVarAgainstDef(prev, def)) {
      cardVars[def.name] = prev.value
    } else {
      cardVars[def.name] = def.initial
    }
  }
  pool.card = cardVars

  // Interaction 变量
  const interactionVars: Record<string, number | string | boolean> = {}
  const interactionDefs = registry.filter(d => d.scope === "interaction")
  for (const def of interactionDefs) {
    const prev = input.prevInteractionStates?.[def.name]
    if (prev && validateVarAgainstDef(prev, def)) {
      interactionVars[def.name] = prev.value
    } else {
      interactionVars[def.name] = def.initial
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
      pool.card[def.name] = def.initial
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

  // [Card变量 - 可通过 var_write 更新]
  const cardDefMap = new Map(registry.filter(d => d.scope === "card").map(d => [d.name, d]))
  const cardParts: string[] = []
  for (const [name, value] of Object.entries(p.card)) {
    const def = cardDefMap.get(name)
    const meta = def
      ? ` (${def.type}${def.enum ? `, enum: ${def.enum.join("/")}` : ""}${def.min !== undefined ? `, ${def.min}..${def.max ?? ""}` : ""}, updateBy=${def.updateBy}): ${def.description}`
      : ""
    cardParts.push(`${name}=${formatVal(value)}${meta}`)
  }
  lines.push(`[Card变量 - 可通过 var_write 更新]\n${cardParts.join("\n") || "(空)"}`)

  // [互动状态 - 系统维护，只读]
  const intParts = Object.entries(p.interaction)
    .map(([k, v]) => {
      const def = registry.find(d => d.scope === "interaction" && d.name === k)
      return `${k}=${formatVal(v)}${def ? ` (${def.type}, updateBy=${def.updateBy}): ${def.description}` : ""}`
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

// ── LLM 工具操作 ──

export function varRead(name: string): VarDef | null {
  const now = Date.now()
  if (name in pool.system) {
    return { name, value: pool.system[name], source: "system", type: "string" as VarType, updatedAt: now }
  }
  if (name in pool.card) {
    const def = registry.find(d => d.scope === "card" && d.name === name)
    return { name, value: pool.card[name], source: "card", type: def?.type ?? "string", updatedAt: now }
  }
  if (name in pool.interaction) {
    const def = registry.find(d => d.scope === "interaction" && d.name === name)
    return { name, value: pool.interaction[name], source: "interaction", type: def?.type ?? "string", updatedAt: now }
  }
  return null
}

export function varList(): VarDef[] {
  const result: VarDef[] = []
  const now = Date.now()
  for (const [name, value] of Object.entries(pool.system)) {
    result.push({ name, value, source: "system", type: inferType(value), updatedAt: now })
  }
  for (const [name, value] of Object.entries(pool.card)) {
    const def = registry.find(d => d.scope === "card" && d.name === name)
    result.push({ name, value, source: "card", type: def?.type ?? inferType(value), updatedAt: now })
  }
  for (const [name, value] of Object.entries(pool.interaction)) {
    const def = registry.find(d => d.scope === "interaction" && d.name === name)
    result.push({ name, value, source: "interaction", type: def?.type ?? inferType(value), updatedAt: now })
  }
  return result
}

export function varWrite(name: string, rawValue: string): { success: boolean; error?: string } {
  // 1. 禁止写系统变量
  if (name in pool.system) {
    return { success: false, error: `系统变量 ${name} 只读，不可写入` }
  }
  // 2. 禁止写 interaction 变量
  if (name in pool.interaction) {
    return { success: false, error: `互动状态 ${name} 由系统维护，LLM 不可写入` }
  }
  // 3. 必须已注册
  const def = registry.find(d => d.scope === "card" && d.name === name)
  if (!def) {
    return { success: false, error: `变量 ${name} 未在 Card 中注册，不能动态创建` }
  }
  // 4. 必须是 llm 可写
  if (def.updateBy !== "llm") {
    return { success: false, error: `变量 ${name} 的 updateBy=${def.updateBy}，LLM 不可写入` }
  }
  // 5. 类型校验和转换
  const typedValue = inferAndValidate(rawValue, def)
  if (typedValue === undefined) {
    const rangeHint = def.type === "number" && (def.min !== undefined || def.max !== undefined)
      ? `, 范围: ${def.min ?? "-∞"}..${def.max ?? "∞"}`
      : def.type === "string" && def.enum
        ? `, 可选值: ${def.enum.join("/")}`
        : ""
    return { success: false, error: `变量 ${name} 值 "${rawValue}" 不符合 schema: 期望 ${def.type}${rangeHint}` }
  }

  // 6. 写入
  pool.card[name] = typedValue
  savePending = true
  log.info("var_write:", name, "=", typedValue)
  return { success: true }
}

export function varDelete(name: string): { success: boolean; error?: string } {
  if (name in pool.system) {
    return { success: false, error: `系统变量 ${name} 不可删除` }
  }
  if (name in pool.interaction) {
    return { success: false, error: `互动状态 ${name} 由系统维护，不可删除` }
  }
  // Card 变量：reset 到 initial
  const def = registry.find(d => d.scope === "card" && d.name === name)
  if (def) {
    pool.card[name] = def.initial
    savePending = true
    log.info("var_delete(reset):", name, "→", def.initial)
    return { success: true }
  }
  // 未注册但在内存中的变量（兼容旧数据）→ 删除
  if (name in pool.card) {
    delete pool.card[name]
    savePending = true
    log.info("var_delete(compat):", name)
    return { success: true }
  }
  return { success: false, error: `变量 ${name} 不存在` }
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

  pool.interaction[name] = value as number | string | boolean
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
    const vars = data.variables as StageVariables | undefined
    if (!vars || vars.schemaVersion < 1) return null
    return { card: vars.card || {}, interaction: vars.interaction || {} }
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

/** @deprecated v2: 使用 loadCardVars 代替，不再回退旧 vars.json */
export async function readPersistedCharacterVars(
  cardId: string,
): Promise<Record<string, number | string | boolean> | null> {
  const newVars = await loadCardVars(cardId)
  if (newVars && Object.keys(newVars.card).length > 0) {
    const flat: Record<string, number | string | boolean> = {}
    for (const [name, state] of Object.entries(newVars.card)) {
      flat[name] = state.value
    }
    return flat
  }
  return null
}

/** @deprecated v2: 使用 savePoolToDisk 代替，仅支持 v2 格式 */
export function loadVariablePool(
  jsonStr: string, currentCardIdNow: string,
): { restored: boolean; pool: VariablePool } {
  try {
    const data = JSON.parse(jsonStr)
    if (data.schemaVersion && data.schemaVersion >= 2) {
      pool.system = data.system || {}
      currentCardId = currentCardIdNow
      log.info("变量池恢复(v2 system):", Object.keys(pool.system).length, "个系统变量")
      return { restored: true, pool: getPoolSnapshot() }
    }
    log.warn("vars.json 格式不兼容 (schemaVersion<2)，将重新初始化")
  } catch {
    log.warn("vars.json 解析失败，将重新初始化")
  }
  return { restored: false, pool: emptyPool() }
}

// ── 销毁 ──

export function destroyPool(): void {
  currentCardId = null
  registry = []
  pool = emptyPool()
  savePending = false
}

// ── 类型工具 ──

function inferType(value: unknown): VarType {
  if (typeof value === "number") return "number"
  if (typeof value === "boolean") return "boolean"
  return "string"
}

function inferAndValidate(raw: string, def: CardVariableDef): number | string | boolean | undefined {
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
      // 去掉外层引号
      const unquoted = ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
        ? trimmed.slice(1, -1)
        : trimmed
      if (def.enum && !def.enum.includes(unquoted)) return undefined
      return unquoted
    }
  }
}

// ── 工具 handler 构造器 ──

export function buildVarReadHandler(): (params: Record<string, unknown>) => Promise<{ success: boolean; content: string; error?: string }> {
  return async (params) => {
    const name = String(params.name ?? "")
    if (!name) return { success: false, content: "", error: "变量名不能为空" }
    const v = varRead(name)
    if (!v) return { success: false, content: "", error: `变量 ${name} 不存在` }
    return { success: true, content: `${v.name} = ${typeof v.value === "string" ? `"${v.value}"` : v.value} (${v.source})` }
  }
}

export function buildVarListHandler(): () => Promise<{ success: boolean; content: string }> {
  return async () => {
    const vars = varList()
    if (vars.length === 0) return { success: true, content: "(变量池为空)" }
    const lines = vars.map(v => `- ${v.name}: ${typeof v.value === "string" ? `"${v.value}"` : v.value} [${v.source}]`)
    return { success: true, content: lines.join("\n") }
  }
}

export function buildVarWriteHandler(): (params: Record<string, unknown>) => Promise<{ success: boolean; content: string; error?: string }> {
  return async (params) => {
    const name = String(params.name ?? "")
    const value = String(params.value ?? "")
    if (!name) return { success: false, content: "", error: "变量名不能为空" }
    if (value === null || value === undefined || value === "") return { success: false, content: "", error: "变量值不能为空" }
    const result = varWrite(name, value)
    if (!result.success) return { success: false, content: "", error: result.error }
    return { success: true, content: `${name} = ${typeof pool.card[name] === "string" ? `"${pool.card[name]}"` : pool.card[name]}` }
  }
}

export function buildVarDeleteHandler(): (params: Record<string, unknown>) => Promise<{ success: boolean; content: string; error?: string }> {
  return async (params) => {
    const name = String(params.name ?? "")
    if (!name) return { success: false, content: "", error: "变量名不能为空" }
    const result = varDelete(name)
    if (!result.success) return { success: false, content: "", error: result.error }
    const currentVal = pool.card[name]
    const valStr = currentVal !== undefined ? (typeof currentVal === "string" ? `"${currentVal}"` : String(currentVal)) : "(未定义)"
    return { success: true, content: `变量 ${name} 已重置为初始值: ${valStr}` }
  }
}
