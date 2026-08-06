// ==========================================
// 人格注册表 — 事务式激活/切换，始终激活一个 Card
// neutral 默认兜底，替代旧 personality.enabled 开关
// ==========================================

import type { PersonalityCard } from "./types"
import { getCards, getCard } from "./loader"
import { personalityConfig } from "@/services/config"
import {
  initVariablePool, destroyPool, loadCardVars,
  savePoolToDiskStrict, snapshotVariablePoolState, restoreVariablePoolState,
  updateInteractionVar,
} from "./variable-pool"
import {
  generateStagesForCard, loadStagesFromDisk,
  snapshotStagesCache, restoreStagesCache, clearStagesCache,
} from "./stages-cache"
import { createLogger } from "@/services/logger"

const log = createLogger("Registry")

// ── 状态 ──
let activeId: string | null = null
let runtimeReady = false

export interface SwitchResult {
  ok: boolean
  error?: string
  card?: PersonalityCard | null
}

/** 初始化：从配置恢复激活状态（由 App.vue onMounted 调用） */
export async function initRegistry(): Promise<void> {
  runtimeReady = false
  const configuredId = personalityConfig.active

  log.info("人格系统初始化: configured=", configuredId ?? "(无)")

  const allCards = getCards()
  log.info("可用 Card:", allCards.map(c => c.id).join(", ") || "(无)")

  // 优先用配置指定的 Card，否则第一张（neutral 兜底始终存在）
  const target = configuredId && getCard(configuredId)
    ? configuredId
    : allCards[0]?.id ?? null

  if (!target) {
    activeId = null
    destroyPool()
    clearStagesCache()
    runtimeReady = true
    log.warn("没有可用 Card（连 neutral 都找不到），系统降级运行")
    return
  }

  log.info("准备激活 Card:", target)
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
  log.info("人格模块启动完毕: activeCard=", activeId)
}

/** 列出所有已注册人格 */
export function listPersonalities(): PersonalityCard[] {
  return getCards()
}

/** 获取当前激活的人格卡（neutral 兜底） */
export function getActiveCard(): PersonalityCard | null {
  if (!activeId) return null
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
  log.info("准备变量池:", card.id, "| variableDefs:", card.sections.variableDefs.length, "个")

  const prevVars = await loadCardVars(card.id)

  log.info(prevVars && (Object.keys(prevVars.card).length > 0 || Object.keys(prevVars.interaction).length > 0)
    ? "变量池从持久化恢复:" : "变量池按 Card 初始化:", card.id)

  initVariablePool({
    cardId: card.id,
    variableDefs: card.sections.variableDefs,
    prevCardStates: prevVars?.card,
    prevInteractionStates: prevVars?.interaction,
  })
  await savePoolToDiskStrict()
}

/** 切换人格：阻塞完成 stages + 变量池加载/生成；任一失败则回滚 */
export async function switchPersonality(id: string | null): Promise<SwitchResult> {
  const prevActiveId = activeId
  const prevPool = snapshotVariablePoolState()
  const prevStages = snapshotStagesCache()

  if (id === null) {
    // 不允许切换到 null，应该切换到 neutral 而不是关掉
    log.warn("不允许关闭人格（始终有 Card），请切换到 neutral 或其他 Card")
    return { ok: false, error: "不允许关闭人格，请切换到其他 Card（如 neutral）" }
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

// ── Prompt 生成 ──

/** 获取当前 System Prompt（调试用） */
export function getSystemPrompt(): string {
  if (!activeId) return ""
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
    ready: isPersonalityRuntimeReady,
    prompt: getSystemPrompt,
  }
}
