// ==========================================
// 人格模块 v4 — 统一导出入口
// ==========================================

// ── 类型 ──
export type { PersonalityCard, PersonalityState, CardSections } from "./types"

// ── 加载器 ──
export { getCards, getCard, initCards, importUserCard, saveUserCard, mergeUserCards } from "./loader"

// ── 注册表 ──
export {
  initRegistry, listPersonalities, getActiveCard, getActivePersonalityId,
  switchPersonality, isPersonalityEnabled, setPersonalityEnabled,
  isPersonalityRuntimeReady, getSystemPrompt,
} from "./registry"
export type { SwitchResult } from "./registry"

// ── 中间件 ──
export { PetPersonalityMiddleware } from "./middleware"
export type { AgentStage, StageContext, PersonalityEffect } from "./middleware"

// ── v4 新模块 ──
export { initVariablePool, refreshVariablePool, getPoolSnapshot, formatPoolForPrompt, varRead, varWrite, varList, varDelete, saveVariablePoolAsync, savePoolToDisk, savePoolToDiskStrict, loadVariablePool, readPersistedCharacterVars, destroyPool, setSessionStart, getSessionStart } from "./variable-pool"
export type { VariablePool, VarDef, VariablePoolRuntimeState } from "./variable-pool"

export { evaluateWhenEngine, evaluateWhen } from "./when-engine"
export type { WhenRule } from "./when-engine"

export { parseMustRules, pickGreeting, formatToolRules, formatAllRules } from "./must-rules"
export type { MustRules } from "./must-rules"

export { stripEmotionTag, parseEmotionMappings, resolveEmotion, formatEmotionForPrompt } from "./emotion"
export type { EmotionMapping } from "./emotion"

export { loadStages, getCachedStages, snapshotStagesCache, restoreStagesCache, clearStagesCache, getStagePrompt, getSimpleStage, FALLBACK_STAGES, generateStagesForCard, loadStagesFromDisk, buildStagesPrompt, parseStagesResponse, serializeStages, deserializeStages, validateStages, validateStagesForCard } from "./stages-cache"
export type { StagePrompts, StageMap } from "./stages-cache"
