// ==========================================
// 人格注册表 —— 事务式激活/切换/提示生成
// 人格系统不参与 Agent 执行，只影响 Prompt 生成
// ==========================================

import type { PersonalityCard } from "./types"
import { getCards, getCard } from "./loader"
import { personalityConfig } from "@/services/config"
import {
  initVariablePool, destroyPool, readPersistedCharacterVars,
  savePoolToDiskStrict, snapshotVariablePoolState, restoreVariablePoolState,
} from "./variable-pool"
import {
  generateStagesForCard, loadStagesFromDisk,
  snapshotStagesCache, restoreStagesCache, clearStagesCache,
} from "./stages-cache"
import { createLogger } from "@/services/logger"

const log = createLogger("Registry")

// ── 状态 ──
let activeId: string | null = null
let enabled = true
let runtimeReady = false

export interface SwitchResult {
  ok: boolean
  error?: string
  card?: PersonalityCard | null
}

/** 初始化：从配置恢复激活状态（由 App.vue onMounted 调用） */
export async function initRegistry(): Promise<void> {
  enabled = personalityConfig.enabled
  runtimeReady = false
  const configuredId = personalityConfig.active

  if (!enabled) {
    activeId = null
    destroyPool()
    clearStagesCache()
    runtimeReady = true
    log.info("人格系统已禁用，使用零身份模式")
    return
  }

  const target = configuredId && getCard(configuredId)
    ? configuredId
    : getCards()[0]?.id ?? null

  if (!target) {
    activeId = null
    destroyPool()
    clearStagesCache()
    runtimeReady = true
    log.warn("没有可用 Card，使用零身份模式")
    return
  }

  const result = await switchPersonality(target)
  if (!result.ok) {
    activeId = null
    destroyPool()
    clearStagesCache()
    runtimeReady = true
    log.error("启动人格激活失败:", result.error)
    return
  }
  runtimeReady = true
}

/** 列出所有已注册人格 */
export function listPersonalities(): PersonalityCard[] {
  return getCards()
}

/** 获取当前激活的人格卡（null = 使用默认人格） */
export function getActiveCard(): PersonalityCard | null {
  if (!enabled || !activeId) return null
  return getCard(activeId) ?? null
}

export function getActivePersonalityId(): string | null { return activeId }

export function isPersonalityRuntimeReady(): boolean { return runtimeReady }

async function ensureStagesReady(card: PersonalityCard): Promise<void> {
  const loaded = await loadStagesFromDisk(card.id, card.version)
  if (loaded) return

  const generated = await generateStagesForCard(
    card.id,
    card.sections.roleSetting,
    card.sections.languageStyle,
    card.version,
    card.hash,
  )
  if (!generated) throw new Error("阶段文案生成失败")
}

async function prepareVariablePool(card: PersonalityCard): Promise<void> {
  const previousCharVars = await readPersistedCharacterVars(card.id)
  log.info(previousCharVars ? "变量池从持久化恢复:" : "变量池按 Card 初始化:", card.id)

  initVariablePool({
    cardId: card.id,
    initialVars: card.sections.initialVars,
    subscribedSystemVars: card.sections.subscribedSystemVars,
    previousCharVars,
  })
  await savePoolToDiskStrict()
}

/** 切换人格：阻塞完成 stages + 变量池加载/生成；任一失败则回滚 */
export async function switchPersonality(id: string | null): Promise<SwitchResult> {
  const prevActiveId = activeId
  const prevPool = snapshotVariablePoolState()
  const prevStages = snapshotStagesCache()

  if (id === null) {
    try {
      activeId = null
      destroyPool()
      clearStagesCache()
      log.info("已关闭人格，使用零身份模式")
      return { ok: true, card: null }
    } catch (e) {
      activeId = prevActiveId
      restoreVariablePoolState(prevPool)
      restoreStagesCache(prevStages)
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  const card = getCard(id)
  if (!card) {
    const msg = `人格不存在: ${id}`
    log.warn(msg)
    return { ok: false, error: msg }
  }

  try {
    await ensureStagesReady(card)
    await prepareVariablePool(card)
    activeId = id
    log.info("已切换人格:", card.name)
    return { ok: true, card }
  } catch (e) {
    activeId = prevActiveId
    restoreVariablePoolState(prevPool)
    restoreStagesCache(prevStages)
    const msg = e instanceof Error ? e.message : String(e)
    log.error("人格切换失败，已回滚:", card.id, msg)
    return { ok: false, error: msg, card }
  }
}

/** 是否启用人格系统 */
export function isPersonalityEnabled(): boolean {
  return enabled
}

/** 启用/禁用人格系统 */
export function setPersonalityEnabled(v: boolean): void {
  enabled = v
  log.info("人格系统:", v ? "已启用" : "已禁用（使用零身份模式）")
}

// ── Prompt 生成 ──

/**
 * 获取当前 System Prompt
 * v4: 角色设定是 Phase2 专属，这里只返回当前 Card 的角色设定文本。
 */
export function getSystemPrompt(): string {
  if (!enabled || !activeId) return ""
  const card = getCard(activeId)
  return card?.sections.roleSetting ?? ""
}

// ── 暴露到 window 方便 F12 调试 ──
if (typeof window !== "undefined") {
  (window as any).__personality = {
    list: listPersonalities,
    active: getActiveCard,
    activeId: getActivePersonalityId,
    switch: switchPersonality,
    enabled: isPersonalityEnabled,
    setEnabled: setPersonalityEnabled,
    ready: isPersonalityRuntimeReady,
    prompt: getSystemPrompt,
  }
}
