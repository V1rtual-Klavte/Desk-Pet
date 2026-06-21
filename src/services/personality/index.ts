// ==========================================
// 人格模块 —— 统一导出入口
// ==========================================

// ── 类型 ──
export type { PersonalityCard, PersonalityState, BoundaryLevel, BoundaryInfo } from "./types"

// ── 加载器 ──
export { getCards, getCard, initCards } from "./loader"

// ── 注册表 ──
export {
  initRegistry,
  listPersonalities,
  getActiveCard,
  switchPersonality,
  isPersonalityEnabled,
  setPersonalityEnabled,
  getSystemPrompt,
} from "./registry"

// ── 界限 ──
export {
  getBoundaryLevel,
  setBoundaryLevel,
  incrementBoundary,
  resetBoundary,
  getBoundaryInfo,
} from "./boundary"

// ── 人格中间件 ──
export { PetPersonalityMiddleware } from "./middleware"
export type { AgentStage, StageContext, PersonalityEffect } from "./middleware"
