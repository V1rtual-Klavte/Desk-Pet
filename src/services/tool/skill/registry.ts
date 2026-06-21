// ==========================================
// Skill Registry —— 注册/查询 Skill 定义
// ==========================================

import type { SkillDef } from "./loader"
import { loadAllSkills } from "./loader"
import { createLogger } from "@/services/logger"

const log = createLogger("SkillReg")

const registry = new Map<string, SkillDef>()

/** 初始化：加载并注册所有 Skill */
export function initSkillRegistry(): void {
  const skills = loadAllSkills()
  for (const s of skills) {
    registry.set(s.meta.id, s)
    log.debug("注册 Skill:", s.meta.id)
  }
}

/** 按 ID 获取 Skill */
export function getSkill(id: string): SkillDef | undefined {
  return registry.get(id)
}

/** 列出所有 Skill */
export function listSkills(): SkillDef[] {
  return [...registry.values()]
}

/** 按关键词匹配 Skill */
export function matchSkills(text: string): SkillDef[] {
  return listSkills().filter(s =>
    s.meta.trigger_keywords?.some(kw => text.includes(kw))
  )
}
