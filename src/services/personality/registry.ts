// ==========================================
// 人格注册表 — 事务式激活/切换，始终激活一个 Card
// neutral 默认兜底，替代旧 personality.enabled 开关
//
// 加载策略（2026-10-06 按需化）：只有激活卡常驻内存（`activeCard`）—— 回合冻结、
// 结算比对、主动/观察等热路径都同步取它；非激活卡不驻留，一律按需读单文件
// （`loadCard`），列表用 `listCardMetas` 现读现算。
// ==========================================

import { computed, ref, shallowRef } from "vue"
import type { CardMeta, PersonalityCard } from "./types"
import { listCardMetas, loadCard } from "./loader"
import { personalityConfig } from "@/services/config"
import {
  initVariablePool, destroyPool, loadCardVars,
  savePoolToDiskStrict, snapshotVariablePoolState, restoreVariablePoolState,
  updateInteractionVar, getCardVarValue,
} from "./variable-pool"
import {
  generateStagesForCard, loadStagesFromDisk, stageSourceHash,
  snapshotStagesCache, restoreStagesCache, clearStagesCache,
} from "./stages-cache"
import { createLogger } from "@/services/logger"
import { formatError, reportError } from "@/services/error"

const log = createLogger("Registry")

// ── 状态 ──
// activeId 用 ref、activeCard 用 shallowRef：界面显示的角色名（activeCardName）由二者
// 派生，切卡/回滚/写后重载后必须自动刷新；activeCard 只跟踪引用替换（Card 本身不做深代理）。
const activeId = ref<string | null>(null)
const activeCard = shallowRef<PersonalityCard | null>(null)
let runtimeReady = false

export interface SwitchResult {
  ok: boolean
  error?: string
  card?: PersonalityCard | null
  /** 失败分类：`not_found`（不存在/读不到）是启动期「配置卡回退第一张」的唯一依据。 */
  reason?: "invalid" | "not_found" | "prepare_failed"
}

/** 初始化：从配置恢复激活状态（由领域引导 initDomainBootstrap 调用） */
export async function initRegistry(): Promise<void> {
  runtimeReady = false
  const configuredId = personalityConfig.active

  log.info("人格系统初始化: configured=", configuredId ?? "(无)")

  // 优先用配置指定的 Card（正常路径只读这一张）；读不到才列目录回退第一张
  // （neutral 兜底始终存在）。准备阶段失败（非 not_found）维持旧语义：直接降级，不回退。
  if (configuredId) {
    const result = await switchPersonality(configuredId)
    if (result.ok) {
      runtimeReady = true
      log.info("人格模块启动完毕: activeCard=", activeId.value)
      return
    }
    if (result.reason !== "not_found") {
      degradeStartup(`启动人格激活失败: ${result.error}`)
      return
    }
    log.warn("配置的 Card 读不到，回退到可用列表第一张:", configuredId)
  }

  const metas = await listCardMetas()
  log.info("可用 Card:", metas.map(meta => meta.id).join(", ") || "(无)")
  const target = metas[0]?.id ?? null

  if (!target) {
    activeId.value = null
    activeCard.value = null
    destroyPool()
    clearStagesCache()
    runtimeReady = true
    log.warn("没有可用 Card（连 neutral 都找不到），系统降级运行")
    return
  }

  log.info("准备激活 Card:", target)
  const result = await switchPersonality(target)
  if (!result.ok) {
    degradeStartup(`启动人格激活失败: ${result.error}`)
    return
  }
  runtimeReady = true
  log.info("人格模块启动完毕: activeCard=", activeId.value)
}

/** 启动降级：没有可用卡/激活失败时清空运行态，系统以「无活动卡」继续运行。 */
function degradeStartup(message: string): void {
  activeId.value = null
  activeCard.value = null
  destroyPool()
  clearStagesCache()
  runtimeReady = true
  log.error(message)
  reportError("Registry", new Error(message), { kind: "启动人格激活失败", overlay: false })
}

/** 列出全部 Card 的元信息（设置页/调试；现读现算，不进缓存） */
export function listPersonalities(): Promise<CardMeta[]> {
  return listCardMetas()
}

/** 获取当前激活的人格卡（只有它是常驻对象；无激活卡时返回 null） */
export function getActiveCard(): PersonalityCard | null {
  return activeCard.value
}

export function getActivePersonalityId(): string | null { return activeId.value }

/**
 * 当前 Card 的显示名（响应式）：供界面显示角色名（如聊天气泡的说话人标签）。
 * 从 activeId + 常驻 activeCard 派生，切卡、回滚、写后重载后自动更新 —— 界面不硬编码
 * 角色名。Card 声明 nameVar 时（名字由用户起）优先显示该变量值：起名后跟随、改名后同步；
 * 未起名返回空串交给界面兜底，不回落到卡标签。变量写入经池代际（poolRevision）触发重算。
 */
export const activeCardName = computed<string>(() => {
  if (!activeId.value) return ""
  const card = activeCard.value
  if (!card || card.id !== activeId.value) return activeId.value
  if (card.nameVar) {
    const given = getCardVarValue(card.nameVar)
    return typeof given === "string" ? given.trim() : ""
  }
  return card.name
})

export function isPersonalityRuntimeReady(): boolean { return runtimeReady }

/**
 * 重载激活卡常驻副本（编辑保存 / 重命名 / 导入覆盖 / 恢复默认资源之后调用）。
 *
 * 读不到/失败时保留旧副本并留痕：不把一次读失败伪装成「卡没了」；运行中的回合已
 * 冻结当轮 Card，改动从下一轮装配起生效。
 */
export async function reloadActiveCard(): Promise<void> {
  const id = activeId.value
  if (!id) return
  try {
    const card = await loadCard(id)
    if (!card) {
      log.warn("激活卡重载读不到文件，保留内存副本:", id)
      return
    }
    activeCard.value = card
    log.info("激活卡已重载:", card.id)
  } catch (e) {
    log.error("激活卡重载失败，保留内存副本:", id, formatError(e))
  }
}

// 顺序固定：先用 Card 现算一次 sourceHash → 先 load（命中即零 LLM 调用）→ 失败才 generate。
// 不能反：generate 会覆写 stages 段，先 load 才保得住既有缓存（FIX-38③）。
async function ensureStagesReady(card: PersonalityCard): Promise<void> {
  const sourceHash = await stageSourceHash(card)

  const loaded = await loadStagesFromDisk(card.id, sourceHash)
  if (loaded) return

  const generated = await generateStagesForCard(card)
  if (!generated) throw new Error("阶段文案生成失败")
}

async function prepareVariablePool(card: PersonalityCard): Promise<void> {
  for (const def of card.sections.variableDefs) {
    const bands=def.proactiveBands
    if(!bands)continue
    if(def.scope!=="card"||def.type!=="number"||def.min===undefined||def.max===undefined||def.max<=def.min
      ||bands.length<2||bands[0]!==def.min||bands.some((value,index)=>!Number.isFinite(value)||value<def.min!||value>=def.max!||(index>0&&value<=bands[index-1]!))) {
      throw new Error(`Card 主动变量档位无效: ${def.name}`)
    }
  }
  log.info("准备变量池:", card.id, "| variableDefs:", card.sections.variableDefs.length, "个")

  const prevVars = await loadCardVars(card.id)

  log.info(prevVars && (Object.keys(prevVars.card).length > 0 || Object.keys(prevVars.interaction).length > 0)
    ? "变量池从持久化恢复:" : "变量池按 Card 初始化:", card.id)

  initVariablePool({
    cardId: card.id,
    variableDefs: card.sections.variableDefs,
    prevCardStates: prevVars?.card,
    prevInteractionStates: prevVars?.interaction,
    // 游标必须透传：缺了这段，reset 游标只写不读，daily 跨重启仍不生效（FIX-38②）
    lastDailyResetKey: prevVars?.lastDailyResetKey,
    sessionKey: prevVars?.sessionKey,
  })
  await savePoolToDiskStrict()
}

/** 切换人格：读目标卡 → 阻塞完成 stages + 变量池加载/生成；任一失败则回滚 */
export async function switchPersonality(id: string | null): Promise<SwitchResult> {
  const prevActiveId = activeId.value
  const prevCard = activeCard.value
  const prevPool = snapshotVariablePoolState()
  const prevStages = snapshotStagesCache()

  if (id === null) {
    // 不允许切换到 null，应该切换到 neutral 而不是关掉
    log.warn("不允许关闭人格（始终有 Card），请切换到 neutral 或其他 Card")
    return { ok: false, error: "不允许关闭人格，请切换到其他 Card（如 neutral）", reason: "invalid" }
  }

  // 读取失败与「不存在」在启动回退逻辑里同归宿（旧实现里读失败的卡同样不在注册表、
  // 会触发回退第一张），统一按 not_found 分类上报；错误正文保留真实原因。
  let card: PersonalityCard | null = null
  try {
    card = await loadCard(id)
  } catch (e) {
    const msg = formatError(e)
    log.error("人格卡读取失败:", id, msg)
    return { ok: false, error: msg, reason: "not_found" }
  }
  if (!card) {
    const msg = `人格不存在: ${id}`
    log.warn(msg)
    return { ok: false, error: msg, reason: "not_found" }
  }

  try {
    await ensureStagesReady(card)
    await prepareVariablePool(card)
    // 先落常驻副本再改 activeId：activeCardName 是 computed，只跟踪响应式源；
    // activeId 赋值触发重算时必须已能读到新卡（顺序反了会短暂显示旧卡名）。
    activeCard.value = card
    activeId.value = id
    log.info("已切换人格:", card.name)
    return { ok: true, card }
  } catch (e) {
    activeCard.value = prevCard
    activeId.value = prevActiveId
    restoreVariablePoolState(prevPool)
    restoreStagesCache(prevStages)
    const msg = formatError(e)
    log.error("人格切换失败，已回滚:", card.id, msg)
    return { ok: false, error: msg, card, reason: "prepare_failed" }
  }
}

// ── Prompt 生成 ──

/** 获取当前 System Prompt（调试用） */
export function getSystemPrompt(): string {
  return activeCard.value?.sections.roleSetting ?? ""
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
