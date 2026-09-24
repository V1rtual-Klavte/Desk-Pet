// ==========================================
// 阶段文案缓存 — per-card 生成/加载
// §7: 读模板 → 调 LLM → 经 stages-file 写入 stages/{cardId}.json
// 本文件是 stages 段的唯一生产者；变量区由 variable-pool 负责，两者互不抹除。
// ==========================================

import type { PersonalityCard } from "./types"
import { hashCardText } from "./loader"
import type { CommandReplies, FallbackReplies, StageMap, StagePrompts } from "./stages-file"
import { readStagesFile, updateStagesFile } from "./stages-file"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("Stages")

// ── 加载模板 ──
let stagesTemplate: string = ""
const templateModules = import.meta.glob<{ default: string } | string>("./stages-prompt.md", { query: "?raw", eager: true })
for (const [, mod] of Object.entries(templateModules)) {
  stagesTemplate = typeof mod === "string" ? mod : (mod as { default: string }).default
}

// ── 类型 ──
// 文件形态（StagePrompts / StageMap / FallbackReplies）由 stages-file 拥有，
// 这里只消费；下面的 FALLBACK_* 是运行时兜底常量，不是文件形态。

/** 极简中性兜底 — 只在 Card stages 完全不可用时使用 */
const FALLBACK_FALLBACKS: FallbackReplies = {
  concurrentRejected: "上一条还在处理中，请稍后再发",
  maxRetriesExhausted: "重试失败，请稍后再试",
  turnTimeout: "处理超时",
  toolLoopMaxRounds: "处理完成",
  llmUnavailable: ["服务暂不可用"],
  subAgentDone: "完成",
  subAgentFailed: "执行失败",
  subAgentNoResult: "无结果",
  runInterrupted: "上次运行中断，请选择继续或丢弃",
  compactionRejected: "正在压缩，请稍后再发",
  pausedReturnFailed: "暂停输入未能放回队列，请重新发送",
  planCancelled: "计划已取消",
  planCompleted: "计划已完成",
  planResumeBusy: "会话正忙，请稍后再继续计划",
}

/** slash 命令输出的中性兜底：与 COMPACT_MESSAGES 时代同文，只是改由 Card 覆盖 */
const FALLBACK_COMMANDS: CommandReplies = {
  clear: "对话已清空，原会话保留在历史记录里",
  memoryCleared: "记忆已清理",
  compactCompleted: "压缩完成，原始对话已保留。",
  compactDeclined: "未压缩：没有可安全摘要的完整旧轮次。",
  compactNothing: "未压缩：当前没有可压缩的历史。",
  compactBusy: "当前回合仍在进行，请稍后再压缩。",
  compactClosed: "会话运行不可用，无法压缩。",
  compactPending: "还有消息在排队，先处理完再压缩。",
  compactFailed: "压缩失败",
}

export const FALLBACK_STAGES: StageMap = {
  thinking: "思考中...", planning: "正在规划...",
  executing: { _default: "处理中..." },
  done: {
    "fs.read": "读取完成",
    "fs.write": "写入完成",
    "os.exec": "命令完成",
    "os.info": "信息已获取",
    "net.fetch": "请求完成",
    "app.launch": "应用已打开",
    "clip.read": "剪贴板已读取",
    "clip.write": "剪贴板已写入",
    "agent.call": "子代理已完成",
    _default: "完成",
  },
  blocked: {
    "fs.write": "写入已拦截",
    "os.exec": "命令已拦截",
    "clip.write": "剪贴板写入已拦截",
    _default: "操作已拦截",
  },
  error: "出了点问题，请重试",
  retry: "正在重试...",
  commands: FALLBACK_COMMANDS,
  fallbacks: FALLBACK_FALLBACKS,
  greetings: ["你好，有什么可以帮你的吗？"],
}

// ── 内存缓存 ──

let cache: StagePrompts | null = null

export function loadStages(data: StagePrompts): void {
  cache = data
  log.info("stages 已加载:", data.cardId, "v", data.cardVersion)
}

export function getCachedStages(): StagePrompts | null { return cache }

export function snapshotStagesCache(): StagePrompts | null { return cache }

export function restoreStagesCache(state: StagePrompts | null): void { cache = state }

export function clearStagesCache(): void { cache = null }

/** 按工具类别获取工具阶段文案（executing / done / blocked） */
export function getStagePrompt(
  stage: "executing" | "done" | "blocked",
  actionCategory: string,
): string {
  if (!cache) return FALLBACK_STAGES[stage]?._default ?? ""
  const map = cache.stages[stage] as Record<string, string> | undefined
  if (!map) return FALLBACK_STAGES[stage]?._default ?? ""
  return map[actionCategory] || map["_default"] || (FALLBACK_STAGES[stage]?._default ?? "")
}

/** 无类别维度的标量阶段 —— commands/executing/done/blocked 等映射型字段不在其中 */
export type SimpleStageKey = "thinking" | "planning" | "error" | "retry"

/** 获取非工具阶段文案（空串回退 FALLBACK） */
export function getSimpleStage(stage: SimpleStageKey): string | null {
  const val = cache?.stages[stage] ?? FALLBACK_STAGES[stage]
  if (typeof val === "string") return val || (FALLBACK_STAGES[stage] as string) || null
  return null
}

/** 获取 slash 命令的 Card 输出；缺该 key 或为空串时回退中性常量 */
export function getCommandReply(key: keyof CommandReplies): string {
  const val = cache?.stages.commands?.[key]
  if (typeof val === "string" && val.length > 0) return val
  return FALLBACK_COMMANDS[key]
}

/** 获取系统兜底回复，card 文案 → FALLBACK_FALLBACKS 多级降级 */
export function getFallbackReply(key: keyof FallbackReplies): string {
  const fallbacks = cache?.stages.fallbacks ?? FALLBACK_STAGES.fallbacks
  const val: FallbackReplies[keyof FallbackReplies] = fallbacks[key]

  // 数组（llmUnavailable）→ 随机取一条
  if (Array.isArray(val)) {
    if (val.length > 0) return val[Math.floor(Math.random() * val.length)]
    return (FALLBACK_FALLBACKS[key] as string) ?? ""
  }

  // 字符串 → 直接用
  if (typeof val === "string" && val.length > 0) return val

  // 最后的最后：极简中性兜底
  return (FALLBACK_FALLBACKS[key] as string) ?? ""
}

/** 当前 Card 的激活问候语；缺失时回退极简中性问候 */
export function getGreetings(): string[] {
  const greetings = cache?.stages.greetings
  if (Array.isArray(greetings) && greetings.length > 0) return greetings
  return FALLBACK_STAGES.greetings
}

/** 随机选一条当前 Card 的问候语 */
export function pickActiveGreeting(): string | null {
  const greetings = getGreetings()
  if (greetings.length === 0) return null
  return greetings[Math.floor(Math.random() * greetings.length)]
}

/** slash 命令输出的全部键 —— 生成、归一化、失效判定与场景共用这一份清单 */
export const COMMAND_KEYS: ReadonlyArray<keyof CommandReplies> = [
  "clear", "memoryCleared", "compactCompleted", "compactDeclined",
  "compactNothing", "compactBusy", "compactClosed", "compactPending", "compactFailed",
]

/** 系统兜底回复的全部键 —— 同上，单一清单 */
export const FALLBACK_KEYS: ReadonlyArray<keyof FallbackReplies> = [
  "concurrentRejected", "maxRetriesExhausted", "turnTimeout", "toolLoopMaxRounds",
  "llmUnavailable", "subAgentDone", "subAgentFailed", "subAgentNoResult",
  "runInterrupted", "compactionRejected", "pausedReturnFailed",
  "planCancelled", "planCompleted", "planResumeBusy",
]

/** 原始文件形态的键齐备性检查：每个键都必须是非空字符串（llmUnavailable 单列，是数组） */
function hasAllNonEmpty(source: unknown, keys: ReadonlyArray<string>): boolean {
  if (typeof source !== "object" || source === null) return false
  const record = source as Record<string, unknown>
  return keys.every(key => typeof record[key] === "string" && (record[key] as string).length > 0)
}

export function validateStages(data: unknown): data is StagePrompts {
  if (!data || typeof data !== "object") return false
  const d = data as Record<string, unknown>
  if (typeof d.cardId !== "string" || !d.stages) return false
  const s = d.stages as Record<string, unknown>
  // 后加的键一律在这里要求：旧 stages 文件缺它们时判为过期，触发按新模板重新生成。
  // 判定必须看**原始文件形态**，不能先过 normalize —— normalize 会把缺失的键补成中性默认值，
  // 补完就再也分不清「旧模板产物」和「新模板产物」，Card 的定制语气会永久停在系统默认文案上。
  if (typeof s.error !== "string" || typeof s.retry !== "string") return false
  if (!Array.isArray(s.greetings) || s.greetings.length === 0) return false
  if (!hasAllNonEmpty(s.commands, COMMAND_KEYS)) return false
  const fallbacks = s.fallbacks as Record<string, unknown> | undefined
  if (!hasAllNonEmpty(fallbacks, FALLBACK_KEYS.filter(key => key !== "llmUnavailable"))) return false
  return Array.isArray(fallbacks?.llmUnavailable) && (fallbacks.llmUnavailable as unknown[]).length > 0
}

export function validateStagesForCard(
  data: StagePrompts,
  cardId: string,
  sourceHash: string,
): boolean {
  // 失效只看「生成输入」：cardId 归属 + sourceHash。cardVersion 是元数据，不参与判定。
  return data.cardId === cardId && data.sourceHash === sourceHash && validateStages(data)
}

/**
 * 阶段文案的失效键 —— 与生成输入严格同源（buildStagesPrompt 只用这两段），
 * 是全仓唯一定义点。分隔符固定为 "\n"：改它等于让所有 Card 的缓存失效一次。
 */
export async function stageSourceHash(
  card: { sections: { roleSetting: string; languageStyle: string } },
): Promise<string> {
  return hashCardText(`${card.sections.roleSetting}\n${card.sections.languageStyle}`)
}

export async function loadStagesFromDisk(
  cardId: string,
  sourceHash: string,
): Promise<StagePrompts | null> {
  try {
    const file = await readStagesFile(cardId)
    if (!file) return null

    const data = file.stages
    if (!data || !validateStagesForCard(data, cardId, sourceHash)) {
      log.warn("stages 校验失败:", cardId)
      return null
    }
    loadStages(data)
    log.info("stages 从持久化恢复:", `personality/stages/${cardId}.json`)
    return data
  } catch (e) {
    // readStagesFile 已就损坏留证；这里显式降级为「无缓存」，由调用方重生成。
    log.error("stages 持久化文件不可用:", `personality/stages/${cardId}.json`, formatError(e))
    return null
  }
}

/** 填充 stages-prompt.md 模板 */
export function buildStagesPrompt(
  template: string, roleSetting: string, languageStyle: string,
): string {
  return template
    .replace("{角色设定}", roleSetting)
    .replace("{语言风格}", languageStyle)
}

export function parseStagesResponse(jsonStr: string): StageMap | null {
  // 从文本中提取所有 JSON 对象 ({...})，从后往前尝试解析
  // reasoning 模型可能在 CoT 中包含多个 JSON 示例，取最后一个有效对象
  const candidates = extractJSONCandidates(jsonStr)
  for (let i = candidates.length - 1; i >= 0; i--) {
    try { return normalizeStageMap(JSON.parse(candidates[i]) as Partial<StageMap>) } catch {}
  }

  // 候选都失败时尝试宽松解析
  const loose = parseLooseStagesResponse(jsonStr)
  if (loose) return loose

  log.error("stages JSON 解析失败: 无有效 JSON 对象")
  log.error("stages 原始返回:", `len=${jsonStr.length}`, jsonStr.slice(-300))
  return null
}

/** 从文本中提取所有平衡括号包围的 JSON 对象 */
function extractJSONCandidates(text: string): string[] {
  const results: string[] = []
  let i = 0
  while (i < text.length) {
    const start = text.indexOf("{", i)
    if (start === -1) break
    let depth = 0, j = start
    let inString = false, escape = false
    while (j < text.length) {
      const ch = text[j]
      if (inString) {
        if (escape) { escape = false }
        else if (ch === "\\") { escape = true }
        else if (ch === "\"") { inString = false }
      } else {
        if (ch === "\"") { inString = true }
        else if (ch === "{") { depth++ }
        else if (ch === "}") { depth--; if (depth === 0) { results.push(text.slice(start, j + 1)); break } }
      }
      j++
    }
    i = start + 1
  }
  return results
}

/** 逐键回填：模型漏给或给了空串的键退回中性常量，保证内存形态永远键齐 */
function normalizeFallbacks(raw: unknown): FallbackReplies {
  const out: FallbackReplies = { ...FALLBACK_FALLBACKS, llmUnavailable: [...FALLBACK_FALLBACKS.llmUnavailable] }
  if (!raw || typeof raw !== "object") return out
  const r = raw as Record<string, unknown>
  for (const key of FALLBACK_KEYS) {
    if (key === "llmUnavailable") {
      const value = r.llmUnavailable
      if (Array.isArray(value) && value.length > 0) out.llmUnavailable = value as string[]
      continue
    }
    const value = r[key]
    if (typeof value === "string" && value.length > 0) out[key] = value
  }
  return out
}

function normalizeCommands(raw: unknown): CommandReplies {
  const out: CommandReplies = { ...FALLBACK_COMMANDS }
  if (!raw || typeof raw !== "object") return out
  const r = raw as Record<string, unknown>
  for (const key of COMMAND_KEYS) {
    const value = r[key]
    if (typeof value === "string" && value.length > 0) out[key] = value
  }
  return out
}

function normalizeStageMap(raw: Partial<StageMap>): StageMap {
  return {
    thinking: typeof raw.thinking === "string" ? raw.thinking : FALLBACK_STAGES.thinking,
    planning: typeof raw.planning === "string" ? raw.planning : FALLBACK_STAGES.planning,
    executing: { ...FALLBACK_STAGES.executing, ...(raw.executing || {}) },
    done: { ...FALLBACK_STAGES.done, ...(raw.done || {}) },
    blocked: { ...FALLBACK_STAGES.blocked, ...(raw.blocked || {}) },
    error: typeof raw.error === "string" ? raw.error : FALLBACK_STAGES.error,
    retry: typeof raw.retry === "string" ? raw.retry : FALLBACK_STAGES.retry,
    commands: normalizeCommands(raw.commands),
    fallbacks: normalizeFallbacks(raw.fallbacks),
    greetings: Array.isArray(raw.greetings) && raw.greetings.length > 0
      ? raw.greetings
      : FALLBACK_STAGES.greetings,
  }
}

function parseLooseStagesResponse(raw: string): StageMap | null {
  const text = raw.trim()
  if (!text) return null

  const result: StageMap = normalizeStageMap({})
  result.thinking = readLooseScalar(text, "thinking") ?? readLeadingThinking(text) ?? result.thinking
  result.planning = readLooseScalar(text, "planning") ?? result.planning
  result.error = readLooseScalar(text, "error") ?? result.error
  result.retry = readLooseScalar(text, "retry") ?? result.retry

  result.executing = { ...result.executing, ...readLooseMap(text, "executing") }
  result.done = { ...result.done, ...readLooseMap(text, "done") }
  result.blocked = { ...result.blocked, ...readLooseMap(text, "blocked") }
  result.fallbacks = readLooseFallbacks(text, result.fallbacks)

  const hasAny = Boolean(result.thinking || result.planning || Object.keys(result.executing).length > 1)
  if (hasAny) log.warn("stages 使用 reasoning_content 宽松解析结果")
  return hasAny ? result : null
}

function readLeadingThinking(text: string): string | null {
  const match = text.match(/^:?([^,，]+?)(?=,?\s*planning:|$)/)
  return match?.[1]?.trim() || null
}

function readLooseScalar(text: string, key: string): string | null {
  const keys = ["thinking", "planning", "executing", "done", "blocked", "error", "retry", "commands"]
  const next = keys.filter(k => k !== key).join("|")
  const re = new RegExp(`${key}:\\s*([\\s\\S]*?)(?=,?\\s*(?:${next}):|$)`)
  const match = text.match(re)
  const val = match?.[1]?.trim().replace(/^null$/i, "")
  return val || null
}

function readLooseMap(text: string, section: "executing" | "done" | "blocked"): Record<string, string> {
  const sections = ["executing", "done", "blocked", "error", "retry", "commands"]
  const next = sections.filter(s => s !== section).join("|")
  const sectionMatch = text.match(new RegExp(`${section}:([\\s\\S]*?)(?=,?\\s*(?:${next}):|$)`))
  const body = sectionMatch?.[1]
  if (!body) return {}

  const result: Record<string, string> = {}
  const keys = ["fs.read", "fs.write", "os.exec", "os.info", "net.fetch", "app.launch", "clip.read", "clip.write", "agent.call", "_default", "default"]
  for (const key of keys) {
    const nextKeys = keys.filter(k => k !== key).map(k => k.replace(".", "\\.")).join("|")
    const re = new RegExp(`${key.replace(".", "\\.")}:\\s*([\\s\\S]*?)(?=,?\\s*(?:${nextKeys}):|$)`)
    const match = body.match(re)
    const value = match?.[1]?.trim()
    if (value) result[key === "default" ? "_default" : key] = value
  }
  return result
}

/** 宽松解析 fallbacks 字段，从全文扫描 fallback key 出现位置提取文案 */
function readLooseFallbacks(text: string, defaults: FallbackReplies): FallbackReplies {
  const result = { ...defaults }
  const keySet = new Set(Object.keys(defaults) as (keyof FallbackReplies)[])

  // 把全文按行分割，按顺序 scan 每个 fallback key 的位置
  const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0)

  // scan 模式：遇到 fallback key → 收集直到下一个 fallback key 或结尾
  const found: Partial<Record<keyof FallbackReplies, string[]>> = {}
  let currentKey: keyof FallbackReplies | null = null

  for (const line of lines) {
    // 检查这行是否以某个 fallback key 开头
    let matchedKey: keyof FallbackReplies | null = null
    for (const k of keySet) {
      if (line.startsWith(k)) {
        matchedKey = k
        break
      }
    }

    if (matchedKey) {
      currentKey = matchedKey
      if (!found[currentKey]) found[currentKey] = []
      // key 后面剩余部分（keyvalue → 取 value）
      const value = line.slice(matchedKey.length).trim()
      if (value) found[currentKey]!.push(value)
    } else if (currentKey) {
      // 续行：追加到当前 key
      found[currentKey]!.push(line)
    }
  }

  // 合并结果
  for (const key of keySet) {
    const vals = found[key]
    if (!vals || vals.length === 0) continue
    if (key === "llmUnavailable") {
      // llmUnavailable 是多条随机选择
      if (vals.length > 0) result.llmUnavailable = vals
    } else {
      // 单值 key：取第一条
      if (vals[0]) result[key] = vals[0]
    }
  }

  return result
}

// ── 生成流程 ──

/**
 * 为指定 Card 生成阶段文案（阻塞 LLM 调用）
 * 请求走 engine/pi 的 completePiText，复用主链路的模型解析与网络边界
 * 写盘经 stages-file 的段级合并，只覆写 stages 段、不动变量区
 * @returns 成功的 StagePrompts，失败返回 null
 */
export async function generateStagesForCard(card: PersonalityCard): Promise<StagePrompts | null> {
  const { id: cardId, sections } = card
  if (!stagesTemplate) {
    log.error("stages 模板未加载")
    return null
  }

  const sourceHash = await stageSourceHash(card)
  const prompt = buildStagesPrompt(stagesTemplate, sections.roleSetting, sections.languageStyle)
  log.info("开始生成 stages:", cardId)

  try {
    const { completePiText } = await import("@/services/engine/pi")
    const resp = await completePiText({
      purpose: "stages",
      systemPrompt: "你是一个 JSON 生成器。你的唯一任务是根据模板输出 JSON 对象。不要输出角色对话、不要输出叙述文字、不要输出任何非 JSON 内容。只输出一个完整 JSON 对象。",
      userText: prompt,
      maxTokens: 8192,
    })

    // 将 text 和 thinking 合并后解析，兼容 reasoning 模型把 JSON 放在 reasoning_content 中的情况
    const combinedText = [resp.text, resp.thinking].filter(Boolean).join("\n")
    const stageMap = parseStagesResponse(combinedText || "")
    if (!stageMap) return null

    // 校验：确保 error/retry 是字符串（允许空串，空串走 FALLBACK）
    if (typeof stageMap.error !== "string" || typeof stageMap.retry !== "string") {
      log.error("stages 校验失败: 缺少 error/retry 字段", JSON.stringify(stageMap).slice(0, 200))
      return null
    }

    // greetings 缺失时补中性问候。落盘的文件必须能通过 validateStages，
    // 否则下次启动会判定过期、反复重新生成。
    if (!Array.isArray(stageMap.greetings) || stageMap.greetings.length === 0) {
      log.warn("stages 缺少 greetings，回退中性问候:", cardId)
      stageMap.greetings = [...FALLBACK_STAGES.greetings]
    }

    // 归一化已把漏给的 commands 补成中性常量，所以「模型整段漏了」只能靠比对默认值发现。
    // 补值的理由与 greetings 相同：写盘后必须键齐，判过期会变成反复重生成。
    if (COMMAND_KEYS.every(key => stageMap.commands[key] === FALLBACK_COMMANDS[key])) {
      log.warn("stages 未提供 commands，命令输出回退中性文案:", cardId)
    }

    const result: StagePrompts = {
      cardId,
      cardVersion: card.version,   // 仅元数据/诊断，不参与失效判定
      sourceHash,
      generatedAt: Date.now(),
      isFallback: false,
      stages: stageMap,
    }

    const absolutePath = await updateStagesFile(cardId, { stages: result })
    log.info("stages 已持久化:", absolutePath)

    // 加载到内存缓存
    loadStages(result)
    log.info("stages 生成成功:", cardId)
    return result
  } catch (e) {
    log.error("stages 生成异常:", formatError(e))
    return null
  }
}
