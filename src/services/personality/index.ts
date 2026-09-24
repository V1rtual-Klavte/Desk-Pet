// ==========================================
// 人格模块 — 统一导出入口
// ==========================================

// ── 类型 ──
export type { PersonalityCard, PersonalityState, CardSections, CardVariableDef, VariableState, VariableScope, VariableType, VariableUpdateBy, VariableResetPolicy, VariablePrimitive } from "./types"

// ── 加载器 ──
export { getCards, getCard, initCards, importUserCard, saveUserCard } from "./loader"

// ── 注册表 ──
export {
  initRegistry, listPersonalities, getActiveCard, getActivePersonalityId,
  switchPersonality,
  isPersonalityRuntimeReady, getSystemPrompt,
} from "./registry"
export type { SwitchResult } from "./registry"

// ── 人格运行时模块 ──
export { initVariablePool, buildPoolFromDefs, refreshVariablePool, getPoolSnapshot, formatPoolForPrompt, batchWriteVars, saveVariablePoolAsync, savePoolToDisk, savePoolToDiskStrict, loadCardVars, updateInteractionVar, applyResetPolicies, computeSystemVariables, destroyPool, getVariableRegistry } from "./variable-pool"
export type { VariablePool, VariablePoolRuntimeState } from "./variable-pool"

export { parseMustRules, formatAllRules } from "./must-rules"
export type { MustRules } from "./must-rules"

export { loadStages, getCachedStages, snapshotStagesCache, restoreStagesCache, clearStagesCache, getStagePrompt, getSimpleStage, getFallbackReply, getCommandReply, getGreetings, pickActiveGreeting, FALLBACK_STAGES, FALLBACK_KEYS, COMMAND_KEYS, generateStagesForCard, loadStagesFromDisk, buildStagesPrompt, parseStagesResponse, validateStages, validateStagesForCard, stageSourceHash } from "./stages-cache"
export type { SimpleStageKey } from "./stages-cache"
export { readStagesFile, updateStagesFile } from "./stages-file"
export type { StagePrompts, StageMap, FallbackReplies, CommandReplies, StagesFile, StageFileStages, StageFileVariables } from "./stages-file"
