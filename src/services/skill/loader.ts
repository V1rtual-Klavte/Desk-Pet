// ==========================================
// Skill 加载 —— Pi 原生渐进披露
//
// system prompt 只注入 name / description / location 三行，正文由模型在任务
// 匹配时用 read 工具读取 location 自行加载。
//
// data_root/skills/ 是唯一真相源：随包种子只在首次启动复制一次，之后用户可以
// 改、可以删，应用不再覆盖 —— 与 Profile / Card 同一套所有权模型。
// ==========================================

import type { Skill } from "@earendil-works/pi-agent-core"
import { formatSkillsForSystemPrompt } from "@earendil-works/pi-agent-core"
import { invoke } from "@tauri-apps/api/core"
import yaml from "js-yaml"
import { runtimePath } from "@/services/paths"
import { toolsConfig } from "@/services/config"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("Skill")

/** data_root 下的 Skill 根目录与文件名（Pi 约定：目录名即 skill 名） */
const SKILLS_DIR = "skills"
const SKILL_FILE = "SKILL.md"

/** 单文件读写上限，防止超大 SKILL.md 撑爆 IPC */
const MAX_SKILL_BYTES = 512 * 1024

/** Pi 的 Skill 名校验：小写字母/数字，用单个连字符分段 */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

// ── 类型 ──

export interface SkillSource {
  /** 目录名，同时是模型看到的 skill 名 */
  name: string
  /** 模型可见的一句话说明：什么时候该用这个 skill */
  description: string
  /** frontmatter 之后的正文 */
  body: string
  /** 完整 SKILL.md 原文 */
  raw: string
}

// ── 解析 ──

/**
 * 解析 SKILL.md。只认 Pi 定义的 `name` 与 `description`：
 * 名称必须是 kebab-case，说明必填，两者任一不合规就丢弃这个 Skill。
 */
export function parseSkillSource(raw: string): SkillSource | null {
  const match = raw.match(FRONTMATTER_PATTERN)
  if (!match) return null

  const parsed = yaml.load(match[1])
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null

  const front = parsed as Record<string, unknown>
  const name = typeof front.name === "string" ? front.name.trim() : ""
  const description = typeof front.description === "string" ? front.description.trim() : ""

  if (!SKILL_NAME_PATTERN.test(name)) {
    log.warn("Skill 名不合规（只允许小写字母/数字/连字符）:", name || "(空)")
    return null
  }
  if (!description) {
    log.warn("Skill 缺少 description:", name)
    return null
  }

  return { name, description, body: match[2].trim(), raw }
}

// ── 对外 API ──

let cache: Skill[] | null = null

/**
 * 扫描 data_root/skills/ 加载全部 Skill。
 *
 * 单个 Skill 解析或读取失败只跳过它，不影响其余 Skill 和启动流程。
 */
export async function loadSkills(): Promise<Skill[]> {
  if (cache) return cache

  const skills: Skill[] = []
  try {
    const root = await runtimePath("data", SKILLS_DIR)
    const listing = await invoke<{ entries: { name: string; kind: string }[] }>("file_list", {
      path: root,
    })
    for (const entry of listing.entries) {
      if (entry.kind !== "dir") continue
      try {
        const filePath = await runtimePath("data", SKILLS_DIR, entry.name, SKILL_FILE)
        const file = await invoke<{ content: string }>("file_read", {
          path: filePath,
          maxBytes: MAX_SKILL_BYTES,
        })
        const parsed = parseSkillSource(file.content)
        if (!parsed) continue
        skills.push({
          name: parsed.name,
          description: parsed.description,
          content: parsed.body,
          filePath,
        })
      } catch (e) {
        log.warn("Skill 读取失败，已跳过:", entry.name, "|", formatError(e))
      }
    }
  } catch (e) {
    log.warn("Skill 目录不可用:", formatError(e))
  }

  cache = skills
  log.info(`已加载 ${skills.length} 个 Skill:`, skills.map(s => s.name).join(", ") || "无")
  return skills
}

/** 丢弃缓存并重新扫描 */
export async function refreshSkills(): Promise<Skill[]> {
  cache = null
  return loadSkills()
}

/** 已加载 Skill 的只读快照 */
export function listSkills(): Skill[] {
  return cache ? [...cache] : []
}

/**
 * 注入 system prompt 的 Skill 清单；未启用、未加载或没有 Skill 时返回空串。
 *
 * 清单始终可加载（设置页要展示），但注入与否只由 toolsConfig.skillEnabled 决定。
 */
export function getSkillsPromptBlock(): string {
  if (!toolsConfig.skillEnabled || !cache || cache.length === 0) return ""
  const block = formatSkillsForSystemPrompt(cache)
  return block ? `\n\n${block}` : ""
}

/** 新增或覆盖一个 Skill：写入 data_root/skills/{name}/SKILL.md */
export async function upsertSkill(raw: string): Promise<SkillSource | null> {
  const parsed = parseSkillSource(raw)
  if (!parsed) return null
  const filePath = await runtimePath("data", SKILLS_DIR, parsed.name, SKILL_FILE)
  await invoke("file_write", { path: filePath, content: raw, maxBytes: MAX_SKILL_BYTES })
  await refreshSkills()
  log.info("Skill 已保存:", parsed.name)
  return parsed
}

/** 删除一个 Skill 目录 */
export async function deleteSkill(name: string): Promise<void> {
  await invoke("skill_delete", { name })
  await refreshSkills()
  log.info("Skill 已删除:", name)
}
