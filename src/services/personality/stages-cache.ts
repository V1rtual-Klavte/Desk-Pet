// ==========================================
// 阶段文案缓存 — per-card 生成/加载/持久化
// §7: 读模板 → 调 LLM → 写入 stages/{cardId}.json
// ==========================================

import { createLogger } from "@/services/logger"

const log = createLogger("Stages")

// ── 加载模板 ──
let stagesTemplate: string = ""
const templateModules = import.meta.glob<{ default: string } | string>("./stages-prompt.md", { query: "?raw", eager: true })
for (const [, mod] of Object.entries(templateModules)) {
  stagesTemplate = typeof mod === "string" ? mod : (mod as { default: string }).default
}

// ── 类型 ──

export interface StagePrompts {
  cardId: string
  cardVersion: number
  cardHash: string
  generatedAt: number
  isFallback: boolean
  stages: StageMap
}

export interface StageMap {
  thinking: string | null
  planning: string | null
  idle: string | null
  executing: Record<string, string>
  done: Record<string, string>
  blocked: Record<string, string>
  error: string
  timeout: string
  retry: string
}

export const FALLBACK_STAGES: StageMap = {
  thinking: null, planning: null, idle: null,
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
    "var.read": "变量已读取",
    "var.write": "变量已更新",
    _default: "完成",
  },
  blocked: {
    "fs.write": "写入已拦截",
    "os.exec": "命令已拦截",
    "clip.write": "剪贴板写入已拦截",
    "var.write": "变量写入已拦截",
    _default: "操作已拦截",
  },
  error: "出了点问题，请重试",
  timeout: "操作超时",
  retry: "正在重试...",
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

/** 从缓存获取工具阶段文案（middleware 调用） */
export function getStagePrompt(
  stage: "executing" | "done" | "blocked",
  actionCategory: string,
): string {
  if (!cache) return FALLBACK_STAGES[stage]?._default ?? ""
  const map = cache.stages[stage] as Record<string, string> | undefined
  if (!map) return FALLBACK_STAGES[stage]?._default ?? ""
  return map[actionCategory] || map["_default"] || (FALLBACK_STAGES[stage]?._default ?? "")
}

/** 获取非工具阶段文案（空串回退 FALLBACK） */
export function getSimpleStage(stage: keyof StageMap): string | null {
  const val = cache?.stages[stage] ?? FALLBACK_STAGES[stage]
  if (typeof val === "string") return val || (FALLBACK_STAGES[stage] as string) || null
  return null
}

export function serializeStages(prompts: StagePrompts): string {
  return JSON.stringify(prompts, null, 2)
}

export function deserializeStages(json: string): StagePrompts | null {
  try { return JSON.parse(json) as StagePrompts } catch { return null }
}

export function validateStages(data: unknown): data is StagePrompts {
  if (!data || typeof data !== "object") return false
  const d = data as Record<string, unknown>
  if (typeof d.cardId !== "string" || !d.stages) return false
  const s = d.stages as Record<string, unknown>
  return typeof s.error === "string" && typeof s.timeout === "string"
}

export function validateStagesForCard(
  data: StagePrompts,
  cardId: string,
  cardVersion: number,
): boolean {
  return data.cardId === cardId && data.cardVersion === cardVersion && validateStages(data)
}

export async function loadStagesFromDisk(
  cardId: string,
  cardVersion: number,
): Promise<StagePrompts | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    const raw = await invoke<number[]>("personality_file_read", {
      path: `personality/stages/${cardId}.json`,
    })
    const json = new TextDecoder().decode(new Uint8Array(raw))
    const data = deserializeStages(json)
    if (!data || !validateStagesForCard(data, cardId, cardVersion)) {
      log.warn("stages 校验失败:", cardId)
      return null
    }
    loadStages(data)
    log.info("stages 从持久化恢复:", `personality/stages/${cardId}.json`)
    return data
  } catch (e) {
    log.info("stages 持久化文件不可用:", `personality/stages/${cardId}.json`, e)
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
  try {
    let clean = jsonStr.trim()
    if (clean.startsWith("```")) {
      clean = clean.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "")
    }
    const jsonStart = clean.indexOf("{")
    const jsonEnd = clean.lastIndexOf("}")
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      clean = clean.slice(jsonStart, jsonEnd + 1)
    }
    return normalizeStageMap(JSON.parse(clean) as Partial<StageMap>)
  } catch (e) {
    const loose = parseLooseStagesResponse(jsonStr)
    if (loose) return loose
    log.error("stages JSON 解析失败:", e)
    log.error("stages 原始返回:", `len=${jsonStr.length}`, jsonStr.slice(-300))
    return null
  }
}

function normalizeStageMap(raw: Partial<StageMap>): StageMap {
  return {
    thinking: typeof raw.thinking === "string" ? raw.thinking : FALLBACK_STAGES.thinking,
    planning: typeof raw.planning === "string" ? raw.planning : FALLBACK_STAGES.planning,
    idle: null,
    executing: { ...FALLBACK_STAGES.executing, ...(raw.executing || {}) },
    done: { ...FALLBACK_STAGES.done, ...(raw.done || {}) },
    blocked: { ...FALLBACK_STAGES.blocked, ...(raw.blocked || {}) },
    error: typeof raw.error === "string" ? raw.error : FALLBACK_STAGES.error,
    timeout: typeof raw.timeout === "string" ? raw.timeout : FALLBACK_STAGES.timeout,
    retry: typeof raw.retry === "string" ? raw.retry : FALLBACK_STAGES.retry,
  }
}

function parseLooseStagesResponse(raw: string): StageMap | null {
  const text = raw.trim()
  if (!text) return null

  const result: StageMap = normalizeStageMap({})
  result.thinking = readLooseScalar(text, "thinking") ?? readLeadingThinking(text) ?? result.thinking
  result.planning = readLooseScalar(text, "planning") ?? result.planning
  result.error = readLooseScalar(text, "error") ?? result.error
  result.timeout = readLooseScalar(text, "timeout") ?? result.timeout
  result.retry = readLooseScalar(text, "retry") ?? result.retry

  result.executing = { ...result.executing, ...readLooseMap(text, "executing") }
  result.done = { ...result.done, ...readLooseMap(text, "done") }
  result.blocked = { ...result.blocked, ...readLooseMap(text, "blocked") }

  const hasAny = Boolean(result.thinking || result.planning || Object.keys(result.executing).length > 1)
  if (hasAny) log.warn("stages 使用 reasoning_content 宽松解析结果")
  return hasAny ? result : null
}

function readLeadingThinking(text: string): string | null {
  const match = text.match(/^:?([^,，]+?)(?=,?\s*planning:|$)/)
  return match?.[1]?.trim() || null
}

function readLooseScalar(text: string, key: string): string | null {
  const keys = ["thinking", "planning", "idle", "executing", "done", "blocked", "error", "timeout", "retry"]
  const next = keys.filter(k => k !== key).join("|")
  const re = new RegExp(`${key}:\\s*([\\s\\S]*?)(?=,?\\s*(?:${next}):|$)`)
  const match = text.match(re)
  const val = match?.[1]?.trim().replace(/^null$/i, "")
  return val || null
}

function readLooseMap(text: string, section: "executing" | "done" | "blocked"): Record<string, string> {
  const sections = ["executing", "done", "blocked", "error", "timeout", "retry"]
  const next = sections.filter(s => s !== section).join("|")
  const sectionMatch = text.match(new RegExp(`${section}:([\\s\\S]*?)(?=,?\\s*(?:${next}):|$)`))
  const body = sectionMatch?.[1]
  if (!body) return {}

  const result: Record<string, string> = {}
  const keys = ["fs.read", "fs.write", "os.exec", "os.info", "net.fetch", "app.launch", "clip.read", "clip.write", "agent.call", "var.read", "var.write", "_default", "default"]
  for (const key of keys) {
    const nextKeys = keys.filter(k => k !== key).map(k => k.replace(".", "\\.")).join("|")
    const re = new RegExp(`${key.replace(".", "\\.")}:\\s*([\\s\\S]*?)(?=,?\\s*(?:${nextKeys}):|$)`)
    const match = body.match(re)
    const value = match?.[1]?.trim()
    if (value) result[key === "default" ? "_default" : key] = value
  }
  return result
}

// ── 生成流程 ──

/**
 * 为指定 Card 生成阶段文案（阻塞 LLM 调用）
 * 使用 OpenAICompatibleProvider 统一请求构建，避免 URL 拼接错误
 * @returns 成功的 StagePrompts，失败返回 null
 */
export async function generateStagesForCard(
  cardId: string,
  roleSetting: string,
  languageStyle: string,
  cardVersion: number,
  cardHash: string,
): Promise<StagePrompts | null> {
  if (!stagesTemplate) {
    log.error("stages 模板未加载")
    return null
  }

  const prompt = buildStagesPrompt(stagesTemplate, roleSetting, languageStyle)
  log.info("开始生成 stages:", cardId)

  try {
    const { OpenAICompatibleProvider } = await import("@/services/agent/provider")
    const provider = new OpenAICompatibleProvider()

    const resp = await provider.generateReply({
      messages: [{ id: "stages-gen", role: "user", text: prompt, timestamp: Date.now() }],
      systemPrompt: "你是一个角色扮演系统的文案生成器。只输出 JSON，不要其他内容。严格遵循格式。",
      maxTokens: 8192,
    })

    const stageMap = parseStagesResponse(resp.text || resp.thinking || "")
    if (!stageMap) return null

    // 校验：确保 error/timeout/retry 是字符串（允许空串，空串走 FALLBACK）
    if (typeof stageMap.error !== "string" || typeof stageMap.timeout !== "string" || typeof stageMap.retry !== "string") {
      log.error("stages 校验失败: 缺少 error/timeout/retry 字段", JSON.stringify(stageMap).slice(0, 200))
      return null
    }

    const result: StagePrompts = {
      cardId,
      cardVersion,
      cardHash,
      generatedAt: Date.now(),
      isFallback: false,
      stages: stageMap,
    }

    const { invoke } = await import("@tauri-apps/api/core")
    const path = `personality/stages/${cardId}.json`
    const absolutePath = await invoke<string>("personality_file_write", {
      path,
      content: Array.from(new TextEncoder().encode(serializeStages(result))),
    })
    log.info("stages 已持久化:", absolutePath)

    // 加载到内存缓存
    loadStages(result)
    log.info("stages 生成成功:", cardId)
    return result
  } catch (e) {
    log.error("stages 生成异常:", e)
    return null
  }
}
