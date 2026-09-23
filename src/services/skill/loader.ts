// Skill 目录渐进加载：缓存仅含有界 frontmatter 元数据，正文经 read 按需读取。

import { invoke } from "@tauri-apps/api/core"
import yaml from "js-yaml"
import { runtimePath } from "@/services/paths"
import { toolsConfig } from "@/services/config"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("Skill")
const SKILLS_DIR = "skills"
const SKILL_FILE = "SKILL.md"
const MAX_SKILL_BYTES = 512 * 1024
const MAX_PROMPT_CHARS = 8 * 1024
const MAX_DESCRIPTION_CHARS = 1024
const MAX_CAPABILITY_TAGS = 16
const MAX_CAPABILITY_TAG_CHARS = 64
const CATALOG_TTL_MS = 5 * 60 * 1000
const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

export type SkillMode = "pet" | "assistant"
export type SkillInvocationPolicy = "pet" | "assistant" | "both"

/** 上传校验的短期对象，不会进入 catalog 缓存。 */
export interface SkillSource { name: string; description: string; body: string; raw: string }

/** 第一层常驻索引，刻意没有正文 content/body/raw。 */
export interface SkillMetadata {
  name: string
  description: string
  location: string
  capabilityTags: string[]
  invocationPolicy: SkillInvocationPolicy
  mtime: number
  size: number
  fingerprint: string
}

interface RawSkillCatalogEntry {
  directoryName: string
  filePath: string
  frontmatter: string
  mtimeMs: number
  size: number
  fingerprint: string
}
interface RawSkillCatalog { entries: RawSkillCatalogEntry[]; fingerprint: string; truncated: boolean }
interface SkillCatalog { entries: SkillMetadata[]; fingerprint: string; truncated: boolean; loadedAt: number }

let catalog: SkillCatalog | null = null
let catalogGeneration = 0
let pendingCatalogLoad: { generation: number; promise: Promise<readonly SkillMetadata[]> } | null = null

export function parseSkillSource(raw: string): SkillSource | null {
  const match = raw.match(FRONTMATTER_PATTERN)
  if (!match) return null
  const parsed = parseFrontmatter(match[1])
  return parsed ? { name: parsed.name, description: parsed.description, body: match[2].trim(), raw } : null
}

function parseFrontmatter(frontmatter: string): Pick<SkillMetadata, "name" | "description" | "capabilityTags" | "invocationPolicy"> | null {
  let loaded: unknown
  try { loaded = yaml.load(frontmatter) }
  catch (error) { log.warn("Skill frontmatter 无法解析:", formatError(error)); return null }
  if (!loaded || typeof loaded !== "object" || Array.isArray(loaded)) return null
  const front = loaded as Record<string, unknown>
  const name = typeof front.name === "string" ? front.name.trim() : ""
  const description = typeof front.description === "string" ? front.description.trim() : ""
  if (!SKILL_NAME_PATTERN.test(name)) {
    log.warn("Skill 名不合规（只允许小写字母/数字/连字符）:", name || "(空)")
    return null
  }
  if (!description) { log.warn("Skill 缺少 description:", name); return null }
  if (description.length > MAX_DESCRIPTION_CHARS) {
    log.warn(`Skill description 超过 ${MAX_DESCRIPTION_CHARS} 字符，已跳过:`, name)
    return null
  }
  const rawTags = front.capabilityTags ?? front["capability-tags"]
  const capabilityTags = Array.isArray(rawTags)
    ? rawTags
      .filter((tag): tag is string => typeof tag === "string" && Boolean(tag.trim()))
      .map(tag => tag.trim())
      .filter(tag => tag.length <= MAX_CAPABILITY_TAG_CHARS)
      .slice(0, MAX_CAPABILITY_TAGS)
    : []
  const rawPolicy = front.invocationPolicy ?? front["invocation-policy"]
  const invocationPolicy: SkillInvocationPolicy = rawPolicy === "pet" || rawPolicy === "both" || rawPolicy === "assistant"
    ? rawPolicy : "assistant"
  return { name, description, capabilityTags, invocationPolicy }
}

/** Rust 每个文件仅读取有界 frontmatter；解析后原文立即丢弃。 */
export async function ensureSkillCatalog(): Promise<readonly SkillMetadata[]> {
  while (true) {
    if (catalog && Date.now() - catalog.loadedAt < CATALOG_TTL_MS) return catalog.entries
    if (catalog) {
      invalidateSkillCatalog("ttl")
      continue
    }
    const generation = catalogGeneration
    if (pendingCatalogLoad?.generation === generation) {
      await pendingCatalogLoad.promise
      continue
    }
    const promise = (async (): Promise<readonly SkillMetadata[]> => {
      try {
        const raw = await invoke<RawSkillCatalog>("skill_list_metadata")
        const entries: SkillMetadata[] = []
        for (const entry of raw.entries) {
          const parsed = parseFrontmatter(entry.frontmatter)
          if (!parsed) continue
          if (parsed.name !== entry.directoryName) {
            log.warn("Skill 名与目录不一致，已跳过:", entry.directoryName)
            continue
          }
          entries.push({ ...parsed, location: entry.filePath, mtime: entry.mtimeMs, size: entry.size, fingerprint: entry.fingerprint })
        }
        if (generation === catalogGeneration) {
          catalog = { entries, fingerprint: raw.fingerprint, truncated: raw.truncated, loadedAt: Date.now() }
          if (raw.truncated) log.warn("Skill 目录超过索引上限，未收录的 Skill 不会注入当前会话")
          log.info(`Skill 元数据索引已就绪: ${entries.length} 个 | 指纹:${raw.fingerprint}`)
        }
        return entries
      } catch (error) {
        log.warn("Skill 元数据索引不可用:", formatError(error))
        if (generation === catalogGeneration) catalog = { entries: [], fingerprint: "unavailable", truncated: false, loadedAt: Date.now() }
        return []
      }
    })()
    pendingCatalogLoad = { generation, promise }
    await promise
    if (pendingCatalogLoad?.promise === promise) pendingCatalogLoad = null
    // If invalidated while the request was in flight, loop and await the newer generation.
    if (generation !== catalogGeneration) continue
    return listSkills()
  }
}

/** 保存、删除、刷新与模式切换后使下一轮冻结快照重新扫描。 */
export function invalidateSkillCatalog(reason: "save" | "delete" | "refresh" | "config" | "mode-change" | "dispose" | "ttl"): void {
  catalogGeneration++
  catalog = null
  log.debug("Skill 元数据索引已失效:", reason)
}

export async function refreshSkills(): Promise<readonly SkillMetadata[]> {
  invalidateSkillCatalog("refresh")
  return ensureSkillCatalog()
}

/** 只返回当前缓存，绝不触发 I/O。 */
export function listSkills(): readonly SkillMetadata[] { return catalog?.entries ?? [] }
export function getSkillCatalogFingerprint(): string | null { return catalog?.fingerprint ?? null }

function isAvailableInMode(skill: SkillMetadata, mode: SkillMode): boolean {
  return skill.invocationPolicy === "both" || skill.invocationPolicy === mode
}
function escapeXml(value: string): string {
  const entities: Record<string, string> = { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }
  return value.replace(/[<>&"']/g, char => entities[char])
}

/**
 * 模型可见的仅是 name/description/location，并且受模式、能力与字符预算过滤。
 * 调用方须在冻结 run snapshot 前先 await ensureSkillCatalog()。
 */
export function getSkillsPromptBlock(options: { mode?: SkillMode; capabilityTags?: readonly string[]; maxChars?: number } = {}): string {
  if (!toolsConfig.skillEnabled || !catalog?.entries.length) return ""
  const mode = options.mode ?? "assistant"
  const requiredTags = options.capabilityTags ?? []
  const limit = Math.min(Math.max(options.maxChars ?? MAX_PROMPT_CHARS, 0), MAX_PROMPT_CHARS)
  let used = 0
  const lines: string[] = []
  for (const skill of catalog.entries) {
    if (!isAvailableInMode(skill, mode)) continue
    if (requiredTags.length && !requiredTags.some(tag => skill.capabilityTags.includes(tag))) continue
    const line = `<skill name="${escapeXml(skill.name)}" description="${escapeXml(skill.description)}" location="${escapeXml(skill.location)}" />`
    if (used + line.length > limit) break
    lines.push(line)
    used += line.length
  }
  return lines.length ? `\n\n<available_skills>\n${lines.join("\n")}\n</available_skills>` : ""
}

/** 上传全文只在当前请求中存在，保存后重新建立纯元数据索引。 */
export async function upsertSkill(raw: string): Promise<SkillSource | null> {
  if (new TextEncoder().encode(raw).byteLength > MAX_SKILL_BYTES) {
    log.warn(`Skill 写入被拒绝：超过 ${MAX_SKILL_BYTES} bytes`)
    return null
  }
  const parsed = parseSkillSource(raw)
  if (!parsed) return null
  const filePath = await runtimePath("data", SKILLS_DIR, parsed.name, SKILL_FILE)
  // host 服务写入不纳入许可域（借用者身份是页面实例，host 没有该生命周期），
  // 但用原子替换写入消除半写窗口：读者要么看到旧正文，要么看到完整新正文。
  await invoke("file_write_atomic", { path: filePath, content: raw, maxBytes: MAX_SKILL_BYTES })
  invalidateSkillCatalog("save")
  await ensureSkillCatalog()
  log.info("Skill 已保存:", parsed.name)
  return parsed
}

export async function deleteSkill(name: string): Promise<void> {
  await invoke("skill_delete", { name })
  invalidateSkillCatalog("delete")
  await ensureSkillCatalog()
  log.info("Skill 已删除:", name)
}
