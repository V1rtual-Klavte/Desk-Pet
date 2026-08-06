// ==========================================
// 人格模块 — 统一导出入口
// ==========================================

// ── 类型 ──
export type { PersonalityCard, PersonalityState, CardSections, CardVariableDef, VariableState, VariableScope, VariableType, VariableUpdateBy, VariableResetPolicy, VariablePrimitive } from "./types"

// ── 加载器 ──
export { getCards, getCard, initCards, importUserCard, saveUserCard, mergeUserCards } from "./loader"

// ── 注册表 ──
export {
  initRegistry, listPersonalities, getActiveCard, getActivePersonalityId,
  switchPersonality,
  isPersonalityRuntimeReady, getSystemPrompt,
} from "./registry"
export type { SwitchResult } from "./registry"

// ── 中间件 ──
export { PetPersonalityMiddleware } from "./middleware"
export type { AgentStage, StageContext, PersonalityEffect } from "./middleware"

// ── 人格运行时模块 ──
export { initVariablePool, refreshVariablePool, getPoolSnapshot, formatPoolForPrompt, batchWriteVars, saveVariablePoolAsync, savePoolToDisk, savePoolToDiskStrict, loadCardVars, readSystemVars, updateInteractionVar, setSessionVars, applyResetPolicies, computeSystemVariables, destroyPool, setSessionStart, getSessionStart, getVariableRegistry } from "./variable-pool"
export type { VariablePool, VariablePoolRuntimeState } from "./variable-pool"

export { parseMustRules, pickGreeting, formatAllRules } from "./must-rules"
export type { MustRules } from "./must-rules"

export { parseEmotionMappings, resolveEmotion, formatEmotionForPrompt } from "./emotion"
export type { EmotionMapping } from "./emotion"

export { loadStages, getCachedStages, snapshotStagesCache, restoreStagesCache, clearStagesCache, getStagePrompt, getSimpleStage, getFallbackReply, FALLBACK_STAGES, generateStagesForCard, loadStagesFromDisk, buildStagesPrompt, parseStagesResponse, serializeStages, deserializeStages, validateStages, validateStagesForCard } from "./stages-cache"
export type { StagePrompts, StageMap, FallbackReplies } from "./stages-cache"
