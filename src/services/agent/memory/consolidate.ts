// ==========================================
// 记忆系统 — LLM 记忆整理 + Fork 补充 + 定时器
// ==========================================

import { modeConfig, memoryConfig } from "@/services/config"
import type { MemoryEntry } from "./types"
import { appendMemory, removeMemory, updateMemory, consolidateLocal, getEntries } from "./memory-entries"
import { createLogger } from "@/services/logger"

const log = createLogger("MemoryConsolidate")

// ── LLM 整理 ──

export async function consolidateWithLLM(): Promise<{ removed: number; kept: number; report: string }> {
  const entries = getEntries()
  if (entries.length < 10) {
    const r = consolidateLocal()
    return { ...r, report: `条目较少 (${entries.length})，基础去重` }
  }

  const dump = entries.map(e =>
    `[${e.id.slice(0, 8)}] [${e.category}] [imp:${e.importance}] ${e.content}${e.file ? ` (file:${e.file})` : ""}`
  ).join("\n")

  const prompt = [
    "分析以下长期记忆条目，识别问题并以 JSON 返回处理指令：",
    "{merge:[{keepId, removeIds[]}], conflicts:[{id1, id2, reason}], expired:[{id, reason}], adjust:[{id, newImportance, reason}], newFacts:[{content, category, importance}]}",
    "规则：内容几乎相同→merge | 互相矛盾→conflicts | 超过30天且importance≤3→expired | importance明显不合理→adjust | 从已有条目可推导的重要事实→newFacts",
    "", dump,
  ].join("\n")

  try {
    const { OpenAICompatibleProvider } = await import("@/services/agent/provider")
    const resp = await new OpenAICompatibleProvider().generateReply({
      messages: [{ id: "consolidate", role: "user", text: prompt, timestamp: Date.now() }],
      systemPrompt: "你是一个记忆管理助手。只输出JSON，不要其他内容。",
      thinkingEffort: "medium",
    })
    const jsonText = resp.text.replace(/```json\n?|```/g, "").trim()
    const json = JSON.parse(jsonText)
    const before = entries.length

    if (json.merge) for (const m of json.merge) { if (m.removeIds) for (const id of m.removeIds) removeMemory(id) }
    if (json.expired) for (const e of json.expired) { if (e.id) removeMemory(e.id) }
    if (json.adjust) for (const a of json.adjust) { if (a.id) updateMemory(a.id, { importance: a.newImportance }) }
    if (json.newFacts) for (const f of json.newFacts) { if (f.content) appendMemory(f.content, f.category || "general", f.importance || 5) }

    const removed = before - getEntries().length
    log.info(`LLM 整理完成: ${before} → ${getEntries().length} (${removed} removed)`)
    return { removed, kept: getEntries().length, report: `合并${json.merge?.length ?? 0} 过期${json.expired?.length ?? 0} 调整${json.adjust?.length ?? 0} 新增${json.newFacts?.length ?? 0}` }
  } catch (e) {
    log.warn("LLM 整理失败，回退基础整理", e instanceof Error ? e : undefined)
    const r = consolidateLocal()
    return { ...r, report: `LLM失败，基础去重: ${r.removed} removed` }
  }
}

export function checkAndConsolidate(): boolean {
  if (modeConfig.assistant) {
    consolidateWithLLM().then(r => log.info("LLM 记忆整理:", r.report)).catch(() => {})
    return true
  }
  return consolidateLocal().removed > 0
}

// ── Fork 补充 ──

export async function forkMemorySupplement(dialogueSummary: string): Promise<void> {
  if (!modeConfig.assistant || getEntries().length >= memoryConfig.maxEntries) return
  try {
    const existingSummary = getEntries().slice(0, 20).map(e => e.content).join("; ")
    const prompt = [
      "分析此段对话摘要，提取值得长期记住的信息（不重复已有记忆）。",
      "只输出JSON数组，无重要信息则输出[]：",
      '[{"content":"事实","category":"user|general|reference|project","importance":5-10}]',
      "", `已有记忆: ${existingSummary || "无"}`, "", `对话:\n${dialogueSummary}`,
    ].join("\n")

    const { OpenAICompatibleProvider } = await import("@/services/agent/provider")
    const resp = await new OpenAICompatibleProvider().generateReply({
      messages: [{ id: "fork", role: "user", text: prompt, timestamp: Date.now() }],
      systemPrompt: "只输出JSON数组，不要其他内容。",
      thinkingEffort: "low",
    })
    const jsonText = resp.text.replace(/```json\n?|```/g, "").trim()
    const facts = JSON.parse(jsonText) as { content: string; category: string; importance: number }[]
    if (facts.length > 0) {
      for (const f of facts) {
        if (!f.content) continue
        appendMemory(f.content, f.category || "general", f.importance || 5)
      }
      log.info(`Fork 补充 ${facts.length} 条记忆 → MEMORY.md`)
    }
  } catch { /* 静默 */ }
}

// ── 定时器 ──

let consolidationTimer: ReturnType<typeof setInterval> | null = null

export function startMemoryConsolidationTimer(): void {
  if (consolidationTimer) return
  consolidationTimer = setInterval(() => checkAndConsolidate(), 60 * 60 * 1000)
  log.info("记忆整理定时器已启动 (60min)")
}

export function stopMemoryConsolidationTimer(): void {
  if (consolidationTimer) { clearInterval(consolidationTimer); consolidationTimer = null }
}

// ── 会话结束计数 ──

let sessionEndCounter = 0

export function onSessionEnd(): void {
  sessionEndCounter++
  if (sessionEndCounter >= 2) {
    sessionEndCounter = 0
    log.info("2 个会话结束，触发整理")
    checkAndConsolidate()
  }
}
