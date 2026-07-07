// ==========================================
// 变量池系统 — LLM 管理的 KV 存储
// §4: 变量池（刷新/持久化/工具注册/@system订阅）
// ==========================================

import { createLogger } from "@/services/logger"

const log = createLogger("VarPool")

// ── 类型 ──

export type VarType = "number" | "string" | "boolean"

export interface VarDef {
  name: string
  value: number | string | boolean
  source: "system" | "character"
  type: VarType
  updatedAt: number
  updatedBy?: "system" | "llm"
}

export interface VariablePool {
  system: Record<string, number | string | boolean>
  character: Record<string, number | string | boolean>
}

/** 持久化格式 */
interface PersistedVars {
  cardId: string
  system: Record<string, number | string | boolean>
  character: Record<string, number | string | boolean>
  updatedAt: number
}

// ── 系统变量定义（8 个）──

interface SysVarDef {
  name: string
  type: VarType
  compute: () => number | string | boolean
}

let sessionStartMs: number = Date.now()

/** 设置会话开始时间（由 session 模块在恢复会话时调用） */
export function setSessionStart(ts: number): void {
  sessionStartMs = ts
}

/** 获取当前会话开始时间 */
export function getSessionStart(): number {
  return sessionStartMs
}

function buildSysVarDefs(
  unansweredCount: number,
  messageCount: number,
): SysVarDef[] {
  const now = new Date()
  return [
    { name: "unansweredCount", type: "number", compute: () => unansweredCount },
    { name: "hour", type: "number", compute: () => now.getHours() },
    { name: "minute", type: "number", compute: () => now.getMinutes() },
    { name: "dayOfWeek", type: "number", compute: () => now.getDay() },
    { name: "isNightTime", type: "boolean", compute: () => now.getHours() >= 22 || now.getHours() <= 5 },
    { name: "isWeekend", type: "boolean", compute: () => now.getDay() === 0 || now.getDay() === 6 },
    { name: "sessionMinutes", type: "number", compute: () => Math.floor((Date.now() - sessionStartMs) / 60000) },
    { name: "messageCount", type: "number", compute: () => messageCount },
  ]
}

/** Card 可通过 # @system varName 订阅的扩展系统变量 */
const EXTENDED_SYS_VAR_DEFS: SysVarDef[] = [
  // 预留扩展点
]

function resolveExtendedSysVar(name: string): SysVarDef | undefined {
  return EXTENDED_SYS_VAR_DEFS.find(d => d.name === name)
}

// ── 内部状态 ──

let currentCardId: string | null = null
let pool: VariablePool = { system: {}, character: {} }
/** Card 的 #变量定义 初始值 */
let initialCharVars: Record<string, number | string | boolean> = {}
/** Card 订阅的扩展系统变量名 */
let subscribedSysVars: string[] = []
let savePending = false

export interface VariablePoolRuntimeState {
  currentCardId: string | null
  pool: VariablePool
  initialCharVars: Record<string, number | string | boolean>
  subscribedSysVars: string[]
  savePending: boolean
}

export function snapshotVariablePoolState(): VariablePoolRuntimeState {
  return {
    currentCardId,
    pool: getPoolSnapshot(),
    initialCharVars: { ...initialCharVars },
    subscribedSysVars: [...subscribedSysVars],
    savePending,
  }
}

export function restoreVariablePoolState(state: VariablePoolRuntimeState): void {
  currentCardId = state.currentCardId
  pool = {
    system: { ...state.pool.system },
    character: { ...state.pool.character },
  }
  initialCharVars = { ...state.initialCharVars }
  subscribedSysVars = [...state.subscribedSysVars]
  savePending = state.savePending
}

// ── 初始化 ──

export interface InitPoolInput {
  cardId: string
  /** card.#变量定义 中解析的初始值 */
  initialVars: Record<string, number | string | boolean>
  /** card.#变量定义 中用 # @system 声明的扩展订阅 */
  subscribedSystemVars: string[]
  /** 当前未回复计数 */
  unansweredCount?: number
  /** 当前会话消息数 */
  messageCount?: number
  /** 之前持久化的角色变量（切换 = null） */
  previousCharVars?: Record<string, number | string | boolean> | null
}

export function initVariablePool(input: InitPoolInput): VariablePool {
  currentCardId = input.cardId
  initialCharVars = input.initialVars
  subscribedSysVars = input.subscribedSystemVars

  // 刷新系统变量
  const sysVars: Record<string, number | string | boolean> = {}
  const allDefs = [...buildSysVarDefs(input.unansweredCount ?? 0, input.messageCount ?? 0)]
  for (const name of subscribedSysVars) {
    const def = resolveExtendedSysVar(name)
    if (def && !allDefs.find(d => d.name === name)) {
      allDefs.push(def)
    }
  }
  for (const d of allDefs) {
    sysVars[d.name] = d.compute()
  }

  // 角色变量
  const charVars: Record<string, number | string | boolean> = {}
  if (input.previousCharVars) {
    Object.assign(charVars, input.previousCharVars)
  } else {
    for (const [k, v] of Object.entries(initialCharVars)) {
      if (!subscribedSysVars.includes(k)) {
        charVars[k] = v
      }
    }
  }

  pool = { system: sysVars, character: charVars }
  savePending = true

  log.info("变量池初始化:", currentCardId, "| 系统:", Object.keys(sysVars).length, "| 角色:", Object.keys(charVars).length)
  return { ...pool }
}

// ── 刷新（每轮 agent loop 开始前）──

export interface RefreshInput {
  unansweredCount: number
  messageCount: number
  sessionStartTimestamp?: number
}

export function refreshVariablePool(input: RefreshInput): VariablePool {
  if (input.sessionStartTimestamp) {
    sessionStartMs = input.sessionStartTimestamp
  }

  const sysVars: Record<string, number | string | boolean> = {}
  const allDefs = [...buildSysVarDefs(input.unansweredCount, input.messageCount)]
  for (const name of subscribedSysVars) {
    const def = resolveExtendedSysVar(name)
    if (def && !allDefs.find(d => d.name === name)) {
      allDefs.push(def)
    }
  }
  for (const d of allDefs) {
    sysVars[d.name] = d.compute()
  }

  pool.system = sysVars
  return { ...pool }
}

// ── 快照（只读视图）──

export function getPoolSnapshot(): VariablePool {
  return {
    system: { ...pool.system },
    character: { ...pool.character },
  }
}

/** 生成注入 Prompt 的变量池文本 */
export function formatPoolForPrompt(): string {
  const sysParts = Object.entries(pool.system)
    .map(([k, v]) => `${k}=${typeof v === "string" ? `"${v}"` : v}`)
  const charParts = Object.entries(pool.character)
    .map(([k, v]) => `${k}=${typeof v === "string" ? `"${v}"` : v}`)

  let text = "[变量池]\n"
  text += `系统: ${sysParts.join(", ") || "(空)"}\n`
  text += `角色: ${charParts.join(", ") || "(空)"}`
  return text
}

// ── LLM 工具操作 ──

export function varRead(name: string): VarDef | null {
  if (name in pool.system) {
    const val = pool.system[name]
    return { name, value: val, source: "system", type: inferType(val), updatedAt: Date.now() }
  }
  if (name in pool.character) {
    const val = pool.character[name]
    return { name, value: val, source: "character", type: inferType(val), updatedAt: Date.now() }
  }
  return null
}

export function varList(): VarDef[] {
  const result: VarDef[] = []
  const now = Date.now()
  for (const [name, value] of Object.entries(pool.system)) {
    result.push({ name, value, source: "system", type: inferType(value), updatedAt: now })
  }
  for (const [name, value] of Object.entries(pool.character)) {
    result.push({ name, value, source: "character", type: inferType(value), updatedAt: now })
  }
  return result
}

export function varWrite(name: string, rawValue: string): { success: boolean; error?: string } {
  if (name in pool.system) {
    return { success: false, error: `系统变量 ${name} 只读，不可写入` }
  }

  const charCount = Object.keys(pool.character).length
  if (!(name in pool.character) && charCount >= 100) {
    return { success: false, error: "角色变量已达上限（100 个）" }
  }
  const totalCount = Object.keys(pool.system).length + charCount
  if (!(name in pool.character) && totalCount >= 200) {
    return { success: false, error: "变量总数已达上限（200 个）" }
  }

  const typedValue = inferAndConvert(rawValue, pool.character[name])
  pool.character[name] = typedValue
  savePending = true

  return { success: true }
}

export function varDelete(name: string): { success: boolean; error?: string } {
  if (name in pool.system) {
    return { success: false, error: `系统变量 ${name} 不可删除` }
  }
  if (name in pool.character) {
    delete pool.character[name]
    savePending = true
  }
  return { success: true }
}

// ── 持久化 ──

export async function saveVariablePoolAsync(
  writeFile: (path: string, content: Uint8Array) => Promise<void>,
): Promise<void> {
  if (!savePending || !currentCardId) return

  const data: PersistedVars = {
    cardId: currentCardId,
    system: { ...pool.system },
    character: { ...pool.character },
    updatedAt: Date.now(),
  }

  const json = JSON.stringify(data, null, 2)
  const encoder = new TextEncoder()
  try {
    await writeFile("personality/vars.json", encoder.encode(json))
    savePending = false
    log.debug("变量池已持久化")
  } catch (e) {
    log.warn("变量池持久化失败:", e)
  }
}

export async function saveVariablePoolStrict(
  writeFile: (path: string, content: Uint8Array) => Promise<void>,
): Promise<void> {
  if (!savePending || !currentCardId) return

  const data: PersistedVars = {
    cardId: currentCardId,
    system: { ...pool.system },
    character: { ...pool.character },
    updatedAt: Date.now(),
  }

  const encoder = new TextEncoder()
  await writeFile("personality/vars.json", encoder.encode(JSON.stringify(data, null, 2)))
  savePending = false
  log.debug("变量池已持久化")
}

export function loadVariablePool(
  jsonStr: string,
  currentCardIdNow: string,
): { restored: boolean; pool: VariablePool } {
  try {
    const data = JSON.parse(jsonStr) as PersistedVars
    if (data.cardId === currentCardIdNow) {
      pool.character = data.character || {}
      currentCardId = currentCardIdNow
      log.info("变量池恢复:", Object.keys(pool.character).length, "个角色变量")
      return { restored: true, pool: { ...pool } }
    }
  } catch {
    log.warn("vars.json 解析失败，将重新初始化")
  }
  return { restored: false, pool: { system: {}, character: {} } }
}

export async function readPersistedCharacterVars(
  cardId: string,
): Promise<Record<string, number | string | boolean> | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    const raw = await invoke<number[]>("personality_file_read", { path: "personality/vars.json" })
    const json = new TextDecoder().decode(new Uint8Array(raw))
    const data = JSON.parse(json) as PersistedVars
    if (data.cardId !== cardId) return null
    return data.character || {}
  } catch {
    return null
  }
}

export function destroyPool(): void {
  currentCardId = null
  pool = { system: {}, character: {} }
  initialCharVars = {}
  subscribedSysVars = []
  savePending = false
}

/** 便捷方法：通过 Tauri invoke 持久化变量池 */
export async function savePoolToDisk(): Promise<void> {
  await saveVariablePoolAsync(async (path, bytes) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("personality_file_write", { path, content: Array.from(bytes) })
    } catch { /* 静默失败 */ }
  })
}

/** 便捷方法：严格持久化变量池，失败时抛错给事务切换回滚 */
export async function savePoolToDiskStrict(): Promise<void> {
  await saveVariablePoolStrict(async (path, bytes) => {
    const { invoke } = await import("@tauri-apps/api/core")
    const absolutePath = await invoke<string>("personality_file_write", { path, content: Array.from(bytes) })
    log.info("变量池已持久化:", absolutePath)
  })
}

// ── 类型工具 ──

function inferType(value: unknown): VarType {
  if (typeof value === "number") return "number"
  if (typeof value === "boolean") return "boolean"
  return "string"
}

function inferAndConvert(raw: string, existing: unknown): number | string | boolean {
  const trimmed = raw.trim()
  if (trimmed === "true") return true
  if (trimmed === "false") return false
  const num = parseFloat(trimmed)
  if (!isNaN(num) && String(num) === trimmed) return num
  if (existing !== undefined) {
    if (typeof existing === "number") {
      const n = parseFloat(trimmed)
      if (!isNaN(n)) return n
      return existing
    }
    if (typeof existing === "boolean") {
      if (trimmed === "true") return true
      if (trimmed === "false") return false
      return existing
    }
  }
  return trimmed
}

// ── 工具 handler 构造器 ──

export function buildVarReadHandler(): (params: Record<string, unknown>) => Promise<{ success: boolean; content: string; error?: string }> {
  return async (params) => {
    const name = String(params.name ?? "")
    if (!name) return { success: false, content: "", error: "变量名不能为空" }
    const v = varRead(name)
    if (!v) return { success: false, content: "", error: `变量 ${name} 不存在` }
    return { success: true, content: `${v.name} = ${v.value} (${v.source})` }
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
    if (!value) return { success: false, content: "", error: "变量值不能为空" }
    const result = varWrite(name, value)
    if (!result.success) return { success: false, content: "", error: result.error }
    return { success: true, content: `${name} = ${pool.character[name]}` }
  }
}

export function buildVarDeleteHandler(): (params: Record<string, unknown>) => Promise<{ success: boolean; content: string; error?: string }> {
  return async (params) => {
    const name = String(params.name ?? "")
    if (!name) return { success: false, content: "", error: "变量名不能为空" }
    const result = varDelete(name)
    if (!result.success) return { success: false, content: "", error: result.error }
    return { success: true, content: `变量 ${name} 已删除` }
  }
}
