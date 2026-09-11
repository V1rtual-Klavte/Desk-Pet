// ==========================================
// Skill 加载 —— Pi 原生渐进披露
//
// system prompt 里只注入 name / description / location 三行，
// 正文由模型在任务匹配时用 read 工具读取 location 自行加载。
// 因此每个 Skill 都必须真实落成 data_root/skills/{name}/SKILL.md。
//
// data_root/skills/ 是派生目录：每次启动按当前来源重写，
// 真相源是内置 skills/ 资源与 CONFIG 里的用户 Skill。
// ==========================================

import type { Skill } from "@earendil-works/pi-agent-core"
import { formatSkillsForSystemPrompt } from "@earendil-works/pi-agent-core"
import { invoke } from "@tauri-apps/api/core"
import yaml from "js-yaml"
import { runtimePath } from "@/services/paths"
import { toolsConfig, setOverride } from "@/services/config"
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

/** 内置 Skill 源码，编译期从 bundle 注入 */
const builtinModules = import.meta.glob<string>("/skills/*/SKILL.md", {
  query: "?raw",
  import: "default",
  eager: true,
})

// ── 类型 ──

export interface SkillSource {
  /** 目录名，同时是模型看到的 skill 名 */
  name: string
  /** 模型可见的一句话说明：什么时候该用这个 skill */
  description: string
  /** frontmatter 之后的正文 */
  body: string
  /** 完整 SKILL.md 原文，用于落盘与回写 CONFIG */
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

// ── 来源 ──

function builtinSources(): SkillSource[] {
  const sources: SkillSource[] = []
  for (const [path, raw] of Object.entries(builtinModules)) {
    const parsed = parseSkillSource(raw)
    if (parsed) sources.push(parsed)
    else log.warn("内置 Skill 解析失败:", path)
  }
  return sources
}

function userSources(): SkillSource[] {
  const rawSkills = toolsConfig.skillSkills
  if (!Array.isArray(rawSkills)) return []
  const sources: SkillSource[] = []
  for (const item of rawSkills) {
    if (typeof item?.raw !== "string") continue
    const parsed = parseSkillSource(item.raw)
    if (parsed) sources.push(parsed)
  }
  return sources
}

/** 用户 Skill 覆盖同名的内置 Skill */
function mergeSources(): SkillSource[] {
  const merged = new Map<string, SkillSource>()
  for (const s of builtinSources()) merged.set(s.name, s)
  for (const s of userSources()) merged.set(s.name, s)
  return [...merged.values()]
}

// ── 落盘 ──

async function writeIfChanged(filePath: string, content: string): Promise<void> {
  try {
    const existing = await invoke<{ content: string }>("file_read", {
      path: filePath,
      maxBytes: MAX_SKILL_BYTES,
    })
    if (existing.content === content) return
  } catch {
    // 文件不存在或读不出来 → 继续走写入
  }
  await invoke("file_write", { path: filePath, content, maxBytes: MAX_SKILL_BYTES })
}

// ── 对外 API ──

let cache: Skill[] | null = null

/**
 * 加载全部 Skill，并确保它们在 data_root 下有对应的 SKILL.md。
 *
 * 模型要读 location 才能拿到正文，所以文件必须真实存在。
 * 单个 Skill 落盘失败只跳过它，不影响其余 Skill 和启动流程。
 */
export async function loadSkills(): Promise<Skill[]> {
  if (cache) return cache

  const skills: Skill[] = []
  for (const source of mergeSources()) {
    try {
      const filePath = await runtimePath("data", SKILLS_DIR, source.name, SKILL_FILE)
      await writeIfChanged(filePath, source.raw)
      skills.push({
        name: source.name,
        description: source.description,
        content: source.body,
        filePath,
      })
    } catch (e) {
      log.warn("Skill 落盘失败，本次跳过:", source.name, "|", formatError(e))
    }
  }

  cache = skills
  log.info(`已加载 ${skills.length} 个 Skill:`, skills.map(s => s.name).join(", ") || "无")
  return skills
}

/** 丢弃缓存并重新加载（用户增删 Skill 后调用） */
export async function refreshSkills(): Promise<Skill[]> {
  cache = null
  return loadSkills()
}

/** 已加载 Skill 的只读快照 */
export function listSkills(): Skill[] {
  return cache ? [...cache] : []
}

/** 该 Skill 是否来自用户层。内置 Skill 删不掉（删了会回落到内置版本），UI 用它决定是否给删除按钮。 */
export function isUserSkill(name: string): boolean {
  return userSources().some(s => s.name === name)
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

/** 新增或覆盖一个用户 Skill（写入 CONFIG 覆盖层并刷新） */
export async function upsertUserSkill(raw: string): Promise<SkillSource | null> {
  const parsed = parseSkillSource(raw)
  if (!parsed) return null
  const kept = userSources().filter(s => s.name !== parsed.name)
  writeUserSources([...kept, parsed])
  await refreshSkills()
  log.info("用户 Skill 已保存:", parsed.name)
  return parsed
}

/** 删除一个用户 Skill */
export async function removeUserSkill(name: string): Promise<void> {
  writeUserSources(userSources().filter(s => s.name !== name))
  await refreshSkills()
  log.info("用户 Skill 已删除:", name)
}

function writeUserSources(sources: SkillSource[]): void {
  setOverride("tools.skill.skills", sources.map(s => ({ raw: s.raw })))
}
