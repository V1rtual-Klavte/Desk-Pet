// ==========================================
// 人格卡加载器 v4 — glob 扫描 + Section 解析 + SHA256
// 内置: import.meta.glob 自动发现
// 用户: Tauri fs → {project}/src/services/personality/cards/*.md
// ==========================================

import type { PersonalityCard, CardSections, CardVariableDef, VariableScope, VariableType, VariableUpdateBy, VariableResetPolicy } from "./types"
import { parseEmotionMappings } from "./emotion"
import { parseMustRules } from "./must-rules"
import { createLogger } from "@/services/logger"

const log = createLogger("Persona")

// ── glob 自动扫描内置 cards ──

const BUILTIN_RAW: Record<string, string> = {}
const globModules = import.meta.glob<{ default: string } | string>("./cards/*.md", { query: "?raw", eager: true })
for (const [path, mod] of Object.entries(globModules)) {
  const filename = path.split("/").pop()?.replace(".md", "") ?? path
  if (filename.startsWith("_")) continue
  BUILTIN_RAW[filename] = typeof mod === "string" ? mod : (mod as { default: string }).default
}

// ── 解析 ──

interface CardFrontmatter {
  id: string; name: string; description: string; version: number
}

function parseFrontmatter(raw: string): { meta: CardFrontmatter; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) {
    return { meta: { id: "unknown", name: "Unknown", description: "", version: 1 }, body: raw.trim() }
  }
  const yamlBlock = match[1]!
  const body = match[2]!.trim()
  const meta: CardFrontmatter = { id: "", name: "", description: "", version: 1 }

  for (const line of yamlBlock.split("\n")) {
    const kv = line.match(/^(\w+):\s*(.+)$/)
    if (!kv) continue
    const k = kv[1]!.trim()
    const v = kv[2]!.trim().replace(/^["']|["']$/g, "")
    if (k === "id") meta.id = v
    else if (k === "name") meta.name = v
    else if (k === "description") meta.description = v
    else if (k === "version") meta.version = parseInt(v, 10) || 1
  }
  return { meta, body }
}

// ── 变量定义 v2 解析 ──

interface ParsedVarSection {
  defs: CardVariableDef[]
}

function parseVariableSection(raw: string): ParsedVarSection {
  // 优先尝试 v2 结构化格式（有 ## card 或 ## interaction 子标题）
  if (/^##\s+(card|interaction)/m.test(raw)) {
    return parseV2VariableDefs(raw)
  }
  // fallback: 旧 name: initial 格式
  return parseOldFormatVars(raw)
}

function parseV2VariableDefs(raw: string): ParsedVarSection {
  const defs: CardVariableDef[] = []

  // 按 ## 子标题拆分
  const parts = raw.split(/^##\s+/m)
  for (const part of parts) {
    const firstLine = part.match(/^(.+)$/m)
    if (!firstLine) continue
    const heading = firstLine[1]!.trim()
    let scope: VariableScope | null = null
    if (heading === "card" || heading.startsWith("card")) scope = "card"
    else if (heading === "interaction" || heading.startsWith("interaction")) scope = "interaction"
    if (!scope) continue

    // 提取 fenced YAML block
    const yamlContent = extractFencedBlock(part.slice(firstLine[0]!.length))
    if (!yamlContent) continue

    const parsed = parseSimpleYaml(yamlContent)
    for (const [name, rawVar] of Object.entries(parsed)) {
      defs.push(buildVarDef(name, rawVar, scope))
    }
  }

  return { defs }
}

function parseOldFormatVars(raw: string): ParsedVarSection {
  const initialVars: Record<string, number | string | boolean> = {}

  for (const line of raw.split("\n")) {
    const sysMatch = line.match(/^#\s*@system\s+(\w+)/)
    if (sysMatch) continue  // 旧 @system 标记忽略，v2 不再支持
    // 跳过 HTML 注释和 markdown 注释
    if (/^\s*<!--/.test(line) || /^\s*-->/.test(line)) continue
    const kv = line.match(/^([\w一-鿿]+):\s*(.+)$/)
    if (kv) {
      const key = kv[1]!.trim()
      if (key === "#") continue
      initialVars[key] = parseLiteralVal(kv[2]!.trim())
    }
  }

  // 从旧格式构建兼容 variableDefs（仅 name + initial，无完整 schema）
  const defs: CardVariableDef[] = Object.entries(initialVars).map(([name, val]) => ({
    scope: "card" as VariableScope,
    name,
    type: inferVarType(val),
    initial: val,
    description: "",
    updateBy: "llm" as VariableUpdateBy,
    persistent: true,
    reset: "never" as VariableResetPolicy,
  }))

  return { defs }
}

/** 从文本中提取 ```yaml ... ``` 或 ``` ... ``` fenced block */
function extractFencedBlock(text: string): string | null {
  const match = text.match(/```(?:yaml)?\s*\n([\s\S]*?)\n```/)
  return match?.[1] ?? null
}

/** 简单 YAML 解析：name:\n  key: value 格式 */
function parseSimpleYaml(yaml: string): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {}
  const lines = yaml.split("\n")
  let currentKey: string | null = null
  let currentObj: Record<string, unknown> = {}

  for (const line of lines) {
    const topMatch = line.match(/^(\S[^:]*):\s*$/)
    if (topMatch) {
      if (currentKey) result[currentKey] = currentObj
      currentKey = topMatch[1]!.trim()
      currentObj = {}
      continue
    }
    const propMatch = line.match(/^\s{2,}(\S[^:]*):\s*(.*)$/)
    if (propMatch && currentKey) {
      const propName = propMatch[1]!.trim()
      const rawVal = propMatch[2]!.trim()
      currentObj[propName] = parseYamlValue(rawVal)
    }
  }
  if (currentKey) result[currentKey] = currentObj
  return result
}

function parseYamlValue(raw: string): unknown {
  const t = raw.trim()
  if (t === "true") return true
  if (t === "false") return false
  if (t === "null" || t === "~" || t === "") return null
  // 方括号数组
  if (t.startsWith("[") && t.endsWith("]")) {
    return t.slice(1, -1).split(",").map(s => s.trim().replace(/^["']|["']$/g, ""))
  }
  // 带引号的字符串
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1)
  }
  const n = parseFloat(t)
  if (!isNaN(n) && String(n) === t) return n
  return t
}

function buildVarDef(name: string, raw: Record<string, unknown>, scope: VariableScope): CardVariableDef {
  const initial = raw.initial !== undefined ? toPrimitive(raw.initial) : ""
  const type = (raw.type as VariableType) || inferVarType(initial)
  const defaults = scope === "interaction" ? { updateBy: "system" as const } : { updateBy: "llm" as const }

  return {
    scope,
    name,
    type,
    initial,
    description: String(raw.description ?? ""),
    updateBy: (raw.updateBy as VariableUpdateBy) || defaults.updateBy,
    persistent: raw.persistent !== undefined ? Boolean(raw.persistent) : true,
    min: typeof raw.min === "number" ? raw.min : undefined,
    max: typeof raw.max === "number" ? raw.max : undefined,
    enum: Array.isArray(raw.enum) ? raw.enum.map(String) : undefined,
    reset: (raw.reset as VariableResetPolicy) || "never",
  }
}

function toPrimitive(v: unknown): number | string | boolean {
  if (typeof v === "number" || typeof v === "boolean") return v
  return String(v)
}

function inferVarType(v: unknown): VariableType {
  if (typeof v === "number") return "number"
  if (typeof v === "boolean") return "boolean"
  return "string"
}

/** 按 # Section 解析 body */
function parseSections(body: string): CardSections {
  const sections: Record<string, string> = {}
  let currentSection: string | null = null
  let currentContent: string[] = []

  for (const line of body.split("\n")) {
    const h1 = line.match(/^#\s+(.+)$/)
    if (h1) {
      if (currentSection) sections[currentSection] = currentContent.join("\n").trim()
      currentSection = h1[1]!.trim()
      currentContent = []
      continue
    }
    if (currentSection) currentContent.push(line)
  }
  if (currentSection) sections[currentSection] = currentContent.join("\n").trim()

  // 变量定义 — v2 结构化 YAML 优先，fallback 旧 name: initial 格式
  const varBlock = sections["变量定义"] || ""
  const { defs: variableDefs } = parseVariableSection(varBlock)

  // 行为进阶规则
  const whenRaw = sections["行为进阶"] || ""
  const whenRules: import("./when-engine").WhenRule[] = []
  const blocks = whenRaw.split(/^##\s*规则:\s*/m).filter(b => b.trim())
  for (const block of blocks) {
    const nm = block.match(/^(.+)$/m)
    const wm = block.match(/^when:\s*(.+)$/m)
    const tm = block.match(/^语气:\s*([\s\S]+?)(?=\n\w|$)/m)
    if (nm && wm) {
      whenRules.push({ name: nm[1]!.trim(), when: wm[1]!.trim(), tone: (tm?.[1] ?? "").trim() })
    }
  }

  // 情绪表达
  const emotionRaw = sections["情绪表达"] || ""
  const emotionMappings = parseEmotionMappings(emotionRaw)

  // 必须遵守
  const mustRaw = sections["必须遵守"] || ""
  const mustRules = parseMustRules(mustRaw)

  return {
    roleSetting: sections["角色设定"] || "",
    languageStyle: sections["语言风格"] || "",
    outputRules: sections["输出规则"] || "",
    emotionRaw, emotionMappings, whenRules, mustRules,
    variableDefs,
  }
}

function parseLiteralVal(raw: string): number | string | boolean {
  const t = raw.trim()
  if (t === "true") return true
  if (t === "false") return false
  if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1)
  const n = parseFloat(t)
  return !isNaN(n) ? n : t
}

async function computeHash(content: string): Promise<string> {
  const data = new TextEncoder().encode(content)
  const buf = await crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("")
}

// ── 加载 ──

let cards: PersonalityCard[] = []

async function parseCard(raw: string, source: "builtin" | "user"): Promise<PersonalityCard> {
  const { meta, body } = parseFrontmatter(raw)
  const sections = parseSections(body)
  const hash = await computeHash(raw)
  return { id: meta.id, name: meta.name || meta.id, description: meta.description, version: meta.version, rawContent: raw, sections, hash, source }
}

async function loadBuiltin(): Promise<PersonalityCard[]> {
  const result: PersonalityCard[] = []
  for (const [fileName, raw] of Object.entries(BUILTIN_RAW)) {
    try { result.push(await parseCard(raw, "builtin")) } catch (e) { log.warn(`内置 Card 解析失败: ${fileName}`, e instanceof Error ? e.message : String(e)) }
  }
  return result
}

async function loadUserCards(builtinIds: Set<string>): Promise<PersonalityCard[]> {
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    const files = await invoke<string[]>("personality_file_list", { dirPath: "personality/cards" })
    const result: PersonalityCard[] = []
    for (const file of files.filter(f => f.endsWith(".md") && !f.startsWith("_"))) {
      try {
        const rawBytes = await invoke<number[]>("personality_file_read", { path: `personality/cards/${file}` })
        const raw = new TextDecoder().decode(new Uint8Array(rawBytes))
        const card = await parseCard(raw, "user")
        // 内置 Card 源文件也位于 src/services/personality/cards，避免被 Tauri 扫描后覆盖成 user。
        // 若用户导入同 id 但内容不同，则允许覆盖内置。
        if (builtinIds.has(card.id) && Object.values(BUILTIN_RAW).includes(raw)) continue
        result.push(card)
      } catch (e) {
        log.warn("用户 Card 读取失败:", file, e)
      }
    }
    return result
  } catch (e) {
    log.debug("用户 Card 目录暂不可用:", e)
    return []
  }
}

export async function importUserCard(raw: string): Promise<PersonalityCard> {
  return parseCard(raw, "user")
}

export async function saveUserCard(raw: string): Promise<PersonalityCard> {
  const card = await parseCard(raw, "user")
  if (!card.id || card.id === "unknown") throw new Error("Card 缺少有效 id")
  const safeName = card.id.replace(/[^\w一-鿿-]/g, "_")
  const { invoke } = await import("@tauri-apps/api/core")
  await invoke("personality_file_write", {
    path: `personality/cards/${safeName}.md`,
    content: Array.from(new TextEncoder().encode(raw)),
  })
  return card
}

export async function initCards(): Promise<void> {
  const builtinCards = await loadBuiltin()
  const userCards = await loadUserCards(new Set(builtinCards.map(c => c.id)))
  cards = builtinCards
  mergeUserCards(userCards)
  log.info(`已加载 ${builtinCards.length} 个内置 Card + ${userCards.length} 个用户 Card:`, cards.map(c => c.id).join(", "))
}

export function getCards(): PersonalityCard[] { return cards }

export function mergeUserCards(userCards: PersonalityCard[]): PersonalityCard[] {
  for (const uc of userCards) {
    const idx = cards.findIndex(c => c.id === uc.id)
    if (idx >= 0) cards[idx] = uc; else cards.push(uc)
  }
  return cards
}

export function getCard(id: string): PersonalityCard | undefined {
  return cards.find(c => c.id === id)
}

initCards()

if (import.meta.hot) {
  import.meta.hot.accept(async () => {
    cards = await loadBuiltin()
    log.info("Card HMR:", cards.map(c => c.id).join(", "))
  })
}
