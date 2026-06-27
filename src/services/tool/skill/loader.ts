// ==========================================
// Skill Loader —— 加载 skills/ 目录下的 .md 文件
// 使用 Vite import.meta.glob 编译时导入
// 解析 YAML frontmatter + Markdown 体 → ToolDef
// 用户动态上传的 Skill 持久化到 CONFIG 覆盖层
// ==========================================

import type { ToolDef, ToolResult } from "@/services/tool/types"
import type { ToolDeclaration } from "@/services/agent/types"
import { createLogger } from "@/services/logger"
import { register, unregister } from "@/services/tool/registry"
import { toolsConfig, setOverride } from "@/services/config"

const log = createLogger("SkillLoader")

// ── 类型 ──

export interface SkillMeta {
  id: string
  name: string
  description: string
  trigger_keywords?: string[]
  tools_needed?: string[]
  mode: "assistant"
  safety: "safe" | "normal" | "danger"
}

export interface SkillDef {
  meta: SkillMeta
  systemPrompt: string
  steps: string
}

// ── 解析 YAML frontmatter ──

export function parseFrontmatter(raw: string): { meta: SkillMeta; body: string } | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return null

  const yamlBlock = match[1]
  const body = match[2].trim()
  const meta: Record<string, unknown> = {}

  for (const line of yamlBlock.split("\n")) {
    const kv = line.match(/^(\w+):\s*(.+)$/)
    if (kv) {
      const key = kv[1].trim()
      const val = kv[2].trim().replace(/^["']|["']$/g, "")
      if (key === "trigger_keywords" || key === "tools_needed") {
        meta[key] = val.replace(/^\[|\]$/g, "").split(",").map(s => s.trim().replace(/^["']|["']$/g, ""))
      } else {
        meta[key] = val
      }
    }
  }

  return {
    meta: meta as unknown as SkillMeta,
    body,
  }
}

// ── 编译时加载 skills/*.md ──

const skillModules = import.meta.glob<string>("/skills/*.md", { query: "?raw", import: "default", eager: true })

function loadBuiltinSkills(): SkillDef[] {
  const skills: SkillDef[] = []
  for (const [path, raw] of Object.entries(skillModules)) {
    const parsed = parseFrontmatter(raw)
    if (parsed) {
      skills.push({
        meta: parsed.meta,
        systemPrompt: parsed.meta.description,
        steps: parsed.body,
      })
      log.debug("加载内置 Skill:", parsed.meta.id, "←", path)
    } else {
      log.warn("Skill 解析失败:", path)
    }
  }
  return skills
}

// ── 用户动态 Skill（from CONFIG 覆盖层）──

function loadUserSkills(): SkillDef[] {
  const rawSkills = toolsConfig.skillSkills
  if (!Array.isArray(rawSkills)) return []
  const skills: SkillDef[] = []
  for (const item of rawSkills) {
    if (typeof item.raw === "string") {
      const parsed = parseFrontmatter(item.raw)
      if (parsed) {
        skills.push({
          meta: parsed.meta,
          systemPrompt: parsed.meta.description,
          steps: parsed.body,
        })
      }
    }
  }
  return skills
}

/** 同步用户 Skill 列表到 CONFIG 覆盖层 */
function syncUserSkillsToConfig(userSkills: { raw: string }[]): void {
  setOverride("tools.skill.skills", userSkills)
}

// ── 内存缓存 ──

let _builtinCache: SkillDef[] | null = null
let _allCache: SkillDef[] | null = null

function getBuiltinSkills(): SkillDef[] {
  if (!_builtinCache) _builtinCache = loadBuiltinSkills()
  return _builtinCache
}

/** 使缓存失效（用于 HMR / 动态增删后刷新） */
function invalidateCache(): void {
  _allCache = null
}

// ── 公共 API ──

/** 加载所有 Skill（内置 + 用户） */
export function loadAllSkills(): SkillDef[] {
  if (_allCache) return _allCache
  const builtin = getBuiltinSkills()
  const user = loadUserSkills()

  // 去重：用户 Skill 覆盖同 id 的内置 Skill
  const seen = new Set<string>()
  const merged: SkillDef[] = []
  for (const s of [...user, ...builtin]) {
    if (!seen.has(s.meta.id)) {
      seen.add(s.meta.id)
      merged.push(s)
    }
  }

  _allCache = merged
  log.info(`已加载 ${merged.length} 个 Skill (内置 ${builtin.length} + 用户 ${user.length})`)
  return merged
}

/** 获取已加载的 Skill 列表（只读） */
export function getLoadedSkills(): SkillDef[] {
  return loadAllSkills()
}

/** 从 .md 文本动态添加 Skill → 内存 + CONFIG */
export function addSkillFromMarkdown(raw: string): SkillDef | null {
  const parsed = parseFrontmatter(raw)
  if (!parsed) {
    log.warn("Skill 解析失败: frontmatter 格式不正确")
    return null
  }

  const skill: SkillDef = {
    meta: parsed.meta,
    systemPrompt: parsed.meta.description,
    steps: parsed.body,
  }

  // 注销旧版本（如果存在）
  const oldId = `skill-${parsed.meta.id}`
  unregister(oldId)

  // 更新 CONFIG 覆盖层
  const rawSkills = toolsConfig.skillSkills as { raw: string }[]
  const updated = rawSkills.filter((s: any) => {
    if (typeof s.raw !== "string") return false
    const p = parseFrontmatter(s.raw)
    return p && p.meta.id !== parsed.meta.id
  })
  updated.push({ raw })
  syncUserSkillsToConfig(updated)

  // 注册工具
  const toolDef = skillToToolDef(skill)
  register(toolDef)

  invalidateCache()
  log.info("Skill 已添加:", skill.meta.name, "| 工具:", toolDef.name)
  return skill
}

/** 删除指定 Skill → 内存 + CONFIG */
export function removeSkill(skillId: string): boolean {
  // 更新 CONFIG
  const rawSkills = toolsConfig.skillSkills as { raw: string }[]
  const updated = rawSkills.filter((s: any) => {
    if (typeof s.raw !== "string") return false
    const p = parseFrontmatter(s.raw)
    return p && p.meta.id !== skillId
  })
  syncUserSkillsToConfig(updated)

  // 注销工具
  const toolId = `skill-${skillId}`
  unregister(toolId)

  invalidateCache()
  log.info("Skill 已删除:", skillId)
  return true
}

/** 清空所有用户 Skill */
export function clearAllSkills(): void {
  const skills = loadAllSkills()
  for (const s of skills) {
    unregister(`skill-${s.meta.id}`)
  }
  syncUserSkillsToConfig([])
  invalidateCache()
}

// ── 将 Skill 转换为 ToolDef ──

export function skillToToolDef(skill: SkillDef): ToolDef {
  const safetyMap: Record<string, "SAFE" | "NORMAL"> = {
    safe: "SAFE",
    normal: "NORMAL",
  }

  return {
    id: `skill-${skill.meta.id}`,
    name: `skill_${sanitizeName(skill.meta.id)}`,
    description: skill.meta.description,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: `用户关于 ${skill.meta.name} 的原始请求` },
      },
      required: ["query"],
    },
    safetyLevel: safetyMap[skill.meta.safety] ?? "SAFE",
    source: "skill" as const,
    sourceId: skill.meta.id,
    mode: "assistant" as const,
    timeoutMs: 60000,
    personalityHint: {
      executing: `让我用"${skill.meta.name}"技能帮你...`,
      done: `${skill.meta.name} 完成啦～`,
    },
    async handler(params) {
      const { runSkill } = await import("./runner")
      const result = await runSkill(skill, params)
      return result
    },
  }
}

/** 获取当前所有 Skill 转换的 ToolDef 列表 */
export function getSkillTools(): ToolDef[] {
  return loadAllSkills().map(skillToToolDef)
}

function sanitizeName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_")
}

// ── HMR ──
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    _builtinCache = null
    _allCache = null
    log.info("Skill HMR 完成")
  })
}
