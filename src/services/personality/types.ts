// ==========================================
// 人格模块 —— 类型定义 (v4)
// ==========================================

import type { EmotionMapping } from "./emotion"
import type { WhenRule } from "./when-engine"
import type { MustRules } from "./must-rules"

/** Card 的解析后 sections */
export interface CardSections {
  roleSetting: string
  languageStyle: string
  outputRules: string
  emotionRaw: string
  emotionMappings: EmotionMapping[]
  whenRules: WhenRule[]
  mustRules: MustRules
  initialVars: Record<string, number | string | boolean>
  subscribedSystemVars: string[]
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
