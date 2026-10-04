// ==========================================
// 人格模块 —— 类型定义
// ==========================================

import type { MustRules } from "./must-rules"

// ── 变量状态类型 ──

export type VariableScope = "card" | "interaction"
export type VariableType = "number" | "string" | "boolean"
export type VariableUpdateBy = "llm" | "proactive_response" | "manual" | "system"
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
  min?: number
  max?: number
  /** Inclusive lower bounds for generic proactive transitions; omitted means no transition opportunity. */
  proactiveBands?: number[]
  enum?: string[]
  reset: VariableResetPolicy
}

/** 变量运行时状态 */
export interface VariableState {
  value: VariablePrimitive
  type: VariableType
  updatedAt: number
  updatedBy: "llm" | "proactive_response" | "manual" | "system" | "migration"
}

/** Card 的解析后 sections */
export interface CardSections {
  roleSetting: string
  languageStyle: string
  outputRules: string
  whenText: string
  mustRules: MustRules
  /** Card 注册表变量定义（结构化 schema） */
  variableDefs: CardVariableDef[]
}

/** 人格卡元数据 */
export interface PersonalityCard {
  id: string
  name: string
  /** 可选：声明承载「用户给角色起的名字」的 Card 变量名。声明后聊天气泡的说话人标签
   *  优先显示该变量值；未起名（空值）时回落到界面兜底，不回落到卡标签。 */
  nameVar?: string
  description: string
  version: number
  rawContent: string
  sections: CardSections
  hash: string
  source: "runtime"
}

/** 人格注册表状态 */
export interface PersonalityState {
  activeId: string | null
  enabled: boolean
}
