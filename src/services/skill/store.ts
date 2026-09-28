// ==========================================
// Skill 状态唯一所有者
//
// 技能清单只有这一个所有者：Pi `loadSkills` 的产物（含正文与绝对 filePath）、目录指纹、
// loader 告警，以及我们自有的 `enabled` 过滤结果。
//
// 「磁盘一变，下一个回合就生效」由 syncSkillCatalog() 实现：每回合一次 Rust 指纹核对
// （mtime/size，不读正文），指纹变了才重新加载 —— 没有 TTL，也不需要重启。
// ==========================================

import { invoke } from "@tauri-apps/api/core"
import yaml from "js-yaml"
import {
  BACKGROUND_CONTEXT,
  loadSkills,
  type Skill,
  type SkillDiagnostic,
} from "@earendil-works/pi-agent-core"
import { TauriExecutionEnv } from "@/services/tool/pi/tauri-execution-env"
import { runtimePath } from "@/services/paths"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("Skill")
/** 技能目录与技能文件名的唯一定义点（store 与 loader 共用，属模块内部常量，不进 barrel）。 */
export const SKILLS_DIR = "skills"
export const SKILL_FILE = "SKILL.md"

/**
 * Rust `skill_catalog_fingerprint` 的回执。
 *
 * `count` 是**扫描到的候选条目数**（目录 + 根级 `.md`，并被 Rust 侧上限截断），不是 Pi 会加载的
 * 技能数：真正的清单只能来自本模块的 `listSkills()` / `listEnabledSkills()`。
 */
export interface SkillCatalogFingerprint {
  fingerprint: string
  count: number
  truncated: boolean
}

/**
 * store 持有的技能视图：Pi 原生 `Skill` 加上我们自有的两个字段。
 *
 * `enabled` 与 `relativePath` 只服务披露过滤与设置页；进模型视野的永远只有 Pi
 * `formatSkillsForSystemPrompt` 输出的 name/description/location。
 */
export type ManagedSkill = Skill & {
  /** frontmatter `enabled`：只认布尔 `false` 为关闭；缺省、字符串或其它取值都算开启。 */
  enabled: boolean
  /**
   * skills 根内的域内相对路径（`foo`、`foo/bar`、`foo.md`），删除入口 `skill_delete` 的坐标。
   * 路径不在 skills 根内时（Pi 不会产出，纯防御分支）为 null，此时该技能没有可用坐标。
   */
  relativePath: string | null
}

interface SkillCatalogState {
  skills: ManagedSkill[]
  /** Pi loader 的告警；如实保留，不丢弃也不升级成错误。 */
  diagnostics: SkillDiagnostic[]
  /** 最近一次核对成功的 Rust 指纹；空串是「目录不存在」这一合法状态的指纹。 */
  fingerprint: string
  /** 是否成功核对过至少一次：区分「还没核对」与「核对过且目录为空」。 */
  synced: boolean
  /** 最近一次失败原因；成功后清空。设置页据此区分「索引不可用」与「真的没有 Skill」。 */
  error: string | null
}

let state: SkillCatalogState = { skills: [], diagnostics: [], fingerprint: "", synced: false, error: null }
let inFlight: Promise<Skill[]> | null = null

/**
 * 指纹核对入口 —— 「实时」的唯一实现点，也是唯一的刷新入口（保存、删除、切换开关、Profile 重种子
 * 都走它，没有第二条刷新路径）。
 *
 * 每次调用恰好一次 Rust IPC：指纹没变就直接返回缓存，变了才调 Pi `loadSkills` 重载。
 * 返回**生效清单**（`enabled` 过滤后，即 Pi 与披露块实际拿到的那一份）。
 */
export async function syncSkillCatalog(): Promise<Skill[]> {
  if (inFlight) return inFlight
  const pending = runSync()
  inFlight = pending
  try {
    return await pending
  } finally {
    if (inFlight === pending) inFlight = null
  }
}

async function runSync(): Promise<Skill[]> {
  let snapshot: SkillCatalogFingerprint
  try {
    snapshot = await invoke<SkillCatalogFingerprint>("skill_catalog_fingerprint")
  } catch (error) {
    // 核对失败时磁盘可能已变，但「有没有变」无从判定：保留上一份快照并如实记录，
    // 不用空清单覆盖 —— 下一次核对成功前，模型看到的是最近一次已知状态。
    const message = formatError(error)
    log.warn("Skill 目录指纹核对失败，沿用上一份清单:", message)
    state = { ...state, error: message }
    return enabledSkills()
  }
  if (snapshot.truncated) {
    log.warn("Skill 目录扫描达到上限：指纹只覆盖已扫描部分，上限之外的改动要等目录再变化才会被发现")
  }
  // 指纹核对成功即清空上次失败原因：早退（复用缓存）与重载同为成功路径，清在分支之前让两条
  // 路径共用这一处。只清在早退分支里会漏掉 reload，只清在 reload 里会漏掉早退。
  if (state.error !== null) state = { ...state, error: null }
  if (state.synced && snapshot.fingerprint === state.fingerprint) return enabledSkills()
  try {
    return await reload(snapshot.fingerprint)
  } catch (error) {
    const message = formatError(error)
    log.error("Skill 清单加载失败，沿用上一份清单:", message)
    state = { ...state, error: message }
    return enabledSkills()
  }
}

async function reload(fingerprint: string): Promise<Skill[]> {
  const skillsDir = await runtimePath("data", SKILLS_DIR)
  const env = new TauriExecutionEnv(await TauriExecutionEnv.defaultCwd())
  const { skills, diagnostics } = await loadSkills(env, [skillsDir], BACKGROUND_CONTEXT)
  const managed: ManagedSkill[] = []
  for (const skill of skills) {
    // `enabled` 是我们自有的字段，Pi 的 `Skill` 不带原始 frontmatter，只能回读原文取它。
    // 只发生在重载时（指纹变了才走到这里），稳态零次。
    managed.push({
      ...skill,
      enabled: await readSkillEnabled(env, skill.filePath),
      relativePath: skillRelativePath(skillsDir, skill.filePath),
    })
  }
  // 指纹记的是**加载前**读到的值：加载期间磁盘再变，下一次核对必然发现（只是多一次重载）。
  // `error` 不在这里清：核对成功的清空只在 runSync 的指纹核对之后那一处（reload 只从那里被调用）。
  state = { ...state, skills: managed, diagnostics, fingerprint, synced: true }
  for (const diagnostic of diagnostics) {
    log.warn(`Skill 告警[${diagnostic.code}] ${diagnostic.path}: ${diagnostic.message}`)
  }
  log.info(
    `Skill 清单已就绪: ${managed.length} 个（启用 ${managed.filter(skill => skill.enabled).length} 个）| 指纹:${fingerprint}`,
  )
  return enabledSkills()
}

async function readSkillEnabled(env: TauriExecutionEnv, filePath: string): Promise<boolean> {
  const raw = await env.readTextFile(filePath, BACKGROUND_CONTEXT)
  if (!raw.ok) {
    // 读不到原文时按「启用」处理：这是缺省值，也让模型仍能看到这个技能；
    // 失败原因留在本行日志，不静默。
    log.warn("Skill 开关读取失败，按缺省值（启用）处理:", filePath, raw.error.message)
    return true
  }
  return readEnabledFlag(raw.value)
}

/** 只读缓存，绝不触发 I/O。含被关闭的技能，供设置页列出全部条目。 */
export function listSkills(): readonly ManagedSkill[] {
  return state.skills
}

/** 生效清单（`enabled` 过滤后）：披露块与 `setResources` 用这一份。 */
export function listEnabledSkills(): Skill[] {
  return enabledSkills()
}

/** Pi loader 的告警。空数组表示加载干净，不代表没有技能。 */
export function listSkillDiagnostics(): readonly SkillDiagnostic[] {
  return state.diagnostics
}

/** 最近一次成功核对的指纹；从未核对成功为 null（与「目录不存在」的空串区分开）。 */
export function getSkillCatalogFingerprint(): string | null {
  return state.synced ? state.fingerprint : null
}

/** 最近一次失败原因；任何一次成功核对后为 null（命中缓存的早退与重载都算成功）。 */
export function getSkillCatalogError(): string | null {
  return state.error
}

function enabledSkills(): Skill[] {
  return state.skills.filter(skill => skill.enabled)
}

// ── frontmatter 字段读写（只服务我们自有的字段与落盘坐标） ──

/**
 * 读 frontmatter 里的一个字段。
 *
 * **不参与技能合法性判定** —— 合法性的真相源是 Pi 的 `loadSkills`。这里只读我们自有的
 * `enabled` 与上传时的落盘坐标（`name`）；解析不出来时返回 undefined，由调用方决定缺省值。
 */
export function readFrontmatterField(raw: string, field: string): unknown {
  const block = frontmatterRange(raw)
  if (!block) return undefined
  let loaded: unknown
  try {
    loaded = yaml.load(raw.slice(block.start, block.end))
  } catch (error) {
    log.warn(`Skill frontmatter 无法解析，按缺省处理（字段 ${field}）:`, formatError(error))
    return undefined
  }
  if (!loaded || typeof loaded !== "object" || Array.isArray(loaded)) return undefined
  return (loaded as Record<string, unknown>)[field]
}

/**
 * `enabled` 的缺省规则：只认布尔 `false` 为关闭，其余（缺省、字符串、数字、写错类型）都算开启。
 * 缺省开启是「目录里有就生效」的延续 —— 删掉总开关后，技能不再需要显式启用。
 */
function readEnabledFlag(raw: string): boolean {
  return readFrontmatterField(raw, "enabled") !== false
}

/**
 * 只改 `enabled` 行（没有就补一行），其余字节原样保留。
 *
 * 编辑必须落在原文字节上：Pi 的 `Skill` 只有解析后的 `content` 与 `filePath`，没有原始
 * frontmatter 文本，从它重建文件会丢掉未声明的字段与注释。找不到可用 frontmatter 块时返回 null。
 */
export function applyEnabledFlag(raw: string, enabled: boolean): string | null {
  const block = frontmatterRange(raw)
  if (!block) return null
  const blockText = raw.slice(block.start, block.end)
  const eol = blockText.includes("\r\n") ? "\r\n" : "\n"
  const lines = blockText.split(/\r?\n/)
  const entry = `enabled: ${enabled ? "true" : "false"}`
  const index = lines.findIndex(line => /^enabled[ \t]*:/.test(line))
  // 末尾那项是闭合 `---` 行之前的换行留给 split 的空串：新增一行插在它前面。
  if (index >= 0) lines[index] = entry
  else lines.splice(lines.length - 1, 0, entry)
  return raw.slice(0, block.start) + lines.join(eol) + raw.slice(block.end)
}

interface FrontmatterRange {
  /** 块内容起点：首行 `---` 之后的第一个字符。 */
  start: number
  /** 块内容终点：闭合 `---` 行起点，也就是它前面的换行之后。 */
  end: number
}

/** 判界口径与 Pi（`harness/skills.js` 的 `parseFrontmatter`）一致：首行 `---` 起、第一处 `\n---` 止。 */
function frontmatterRange(raw: string): FrontmatterRange | null {
  if (!raw.startsWith("---")) return null
  const openEnd = raw.indexOf("\n")
  if (openEnd === -1) return null
  const closeStart = raw.indexOf("\n---", openEnd)
  if (closeStart === -1) return null
  return { start: openEnd + 1, end: closeStart + 1 }
}

// ── 删除坐标 ──

/**
 * 取 skills 根内的域内相对路径（`/` 分隔），形态与 Rust 指纹回执、`skill_delete` 的入参一致。
 *
 * Pi 的 `filePath` 是绝对路径且由它自己从 skills 根拼出，所以必然落在根内；路径形态用 Pi
 * `relativeEnvPath` 的同款归一（统一分隔符），Windows/macOS 得到同一结果。
 * 目录技能去掉结尾的 `SKILL.md`：删除坐标是目录，`skill_delete` 会连同目录里的引用文件一起删。
 */
function skillRelativePath(skillsDir: string, filePath: string): string | null {
  const root = normalizeSeparators(skillsDir).replace(/\/+$/, "")
  const full = normalizeSeparators(filePath)
  if (!full.startsWith(`${root}/`)) {
    // 防御分支：Pi 只会从我们传入的目录里取文件，这里取不到坐标时不猜路径，也没有删除入口。
    log.warn("Skill 文件不在 skills 根内，没有删除坐标:", filePath)
    return null
  }
  const relative = full.slice(root.length + 1)
  return relative.endsWith(`/${SKILL_FILE}`) ? relative.slice(0, -(SKILL_FILE.length + 1)) : relative
}

function normalizeSeparators(path: string): string {
  return path.replace(/\\/g, "/")
}
