// ==========================================
// 人格模块 —— 类型定义 (v4 → v5 变量池重构)
// ==========================================

import type { EmotionMapping } from "./emotion"
import type { WhenRule } from "./when-engine"
import type { MustRules } from "./must-rules"

// ── 变量池 v2 类型 ──

export type VariableScope = "card" | "interaction"
export type VariableType = "number" | "string" | "boolean"
export type VariableUpdateBy = "llm" | "manual" | "system"
export type VariableResetPolicy = "never" | "daily" | "session"
export type VariablePrimitive = number | string | boolean

/** Card 中声明的变量定义（注册表条目） */
export interface CardVariableDef {
  scope: VariableScope
  name: string
  type: VariableType
  initial: VariablePrimitive
  description: string
  updateBy: VariableUpdateBy
  persistent: boolean
  min?: number
  max?: number
  enum?: string[]
  reset: VariableResetPolicy
}

/** 变量运行时状态 */
export interface VariableState {
  value: VariablePrimitive
  type: VariableType
  updatedAt: number
  updatedBy: "llm" | "manual" | "system" | "migration"
  lastResetAt?: number
}

/** Card 的解析后 sections */
export interface CardSections {
  roleSetting: string
  languageStyle: string
  outputRules: string
  emotionRaw: string
  emotionMappings: EmotionMapping[]
  whenRules: WhenRule[]
  mustRules: MustRules
  /** @deprecated v2: 使用 variableDefs 代替，保留用于兼容旧格式 Card */
  initialVars: Record<string, number | string | boolean>
  /** @deprecated v2: 使用 variableDefs 代替 */
  subscribedSystemVars: string[]
  /** v2: Card 注册表变量定义（结构化 schema） */
  variableDefs: CardVariableDef[]
}

/** 人格卡元数据 */
export interface PersonalityCard {
  id: string
  name: string
  description: string
  version: number
  rawContent: string
  sections: CardSections
  hash: string
  source: "builtin" | "user"
}

/** 人格注册表状态 */
export interface PersonalityState {
  activeId: string | null
  enabled: boolean
}
