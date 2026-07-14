// ==========================================
// 记忆系统 — 会话文件管理
// sessions/*.md 创建/读取/归档 + 轮次记录
// ==========================================

import { invoke } from "@tauri-apps/api/core"
import type { SessionMemory, ProjectEntry, SessionFileMeta, MemoryEntry, CompactionSummary } from "./types"
import { readSessionFile, writeSessionFile, sessionsDir, withLock } from "./io"
import { localTime, localDate, localCompact, parseSessionFilename, parseSessionFileMeta, parseSessionFromFile, parseTurnsFromRaw, buildSessionFileContent, makeSessionFilename, findTopicFromTurns } from "./parsers"
import { createLogger } from "@/services/logger"

const log = createLogger("MemorySessions")

// ── 模块状态（共享）──
let sessionMemory: SessionMemory | null = null
let projectEntries: ProjectEntry[] = []

export function getSessionMemory(): SessionMemory | null { return sessionMemory }
export function setSessionMemory(sm: SessionMemory | null): void { sessionMemory = sm }
export function getProjectEntries(): ProjectEntry[] { return [...projectEntries] }
export function setProjectEntries(p: ProjectEntry[]): void { projectEntries = p }

// ── SessionMemory 工厂 ──

export function newSessionMemory(): SessionMemory {
  const now = new Date()
  return { sessionId: `session-${localCompact(now)}`, startedAt: now.getTime(), turns: [] }
}

// ── 活跃会话设置 ──

export async function setActiveSession(sessionId: string): Promise<void> {
  if (sessionMemory?.sessionId === sessionId) return
  let startedAt = Date.now()
  let existingTurns: SessionMemory["turns"] = []
  try {
    const files = await invoke<string[]>("list_session_files")
    const match = files.find(f => f.startsWith(sessionId))
    if (match) {
      const raw = await readSessionFile(match)
      if (raw) {
        const startMatch = raw.match(/> 开始:\s*(.+)/)
        if (startMatch) { const d = Date.parse(startMatch[1]); if (!isNaN(d)) startedAt = d }
        existingTurns = parseTurnsFromRaw(raw)
        const tokenMatch = raw.match(/> Token累计:\s*(\d+)\/(\d+)\s*\|\s*上下文:\s*(\d+)%/)
        if (tokenMatch) {
          const { restoreDebugStats } = await import("@/services/debug")
          restoreDebugStats({
            totalPrompt: parseInt(tokenMatch[1], 10),
            totalCompletion: parseInt(tokenMatch[2], 10),
            lastContextUsage: parseInt(tokenMatch[3], 10),
          })
        }
      }
    }
  } catch { /* 静默 */ }
  sessionMemory = { sessionId, startedAt, turns: existingTurns }
  log.info("活跃会话已设置:", sessionId, `(${existingTurns.length} 轮已恢复)`)
}

export function setActiveSessionSync(sessionId: string): void {
  if (sessionMemory?.sessionId === sessionId) return
  sessionMemory = { sessionId, startedAt: Date.now(), turns: [] }
  log.info("活跃会话已设置(sync):", sessionId)
}

// ── 会话文件 CRUD ──

export async function createSessionFile(sessionId: string): Promise<void> {
  setActiveSessionSync(sessionId)
  const filename = makeSessionFilename(sessionId, "新会话")
  const content = [
    `# ${sessionId}-新会话`, `> 开始: ${localTime(new Date())}`, `> 轮数: 0`,
    "", "## 摘要", "<!-- 归档时填充 -->", "", "## 对话记录 (0 轮)", "",
  ].join("\n")
  const ok = await writeSessionFile(filename, content)
  if (ok) {
    log.info("Session 文件已创建:", `${sessionsDir}/${filename}`)
    if (!projectEntries.find(e => e.sessionFile === filename)) {
      projectEntries.push({ sessionFile: filename, date: localDate(), rounds: 0, mainRequest: "新会话", keyTech: [] })
    }
  } else {
    log.error("Session 文件创建失败:", filename, "sessionsDir=", sessionsDir)
  }
}

export async function loadSessionMessages(sessionId: string): Promise<{ role: "user" | "assistant"; text: string; timestamp: number }[] | null> {
  if (!sessionsDir) { log.warn("loadSessionMessages: sessionsDir 未设置"); return null }
  try {
    const files = await invoke<string[]>("list_session_files")
    const match = files.find(f => f.startsWith(sessionId))
    if (!match) { log.warn("loadSessionMessages: 未找到匹配文件", sessionId); return null }
    const raw = await readSessionFile(match)
    if (!raw || raw.length < 20) return null
    const turns: { role: "user" | "assistant"; text: string; timestamp: number }[] = []
    let inConversation = false
    for (const line of raw.split("\n")) {
      if (line.startsWith("## 对话记录")) { inConversation = true; continue }
      if (line.startsWith("## ")) { inConversation = false; continue }
      if (!inConversation) continue
      const m = line.match(/^-\s*\[([^\]]+)\]\s*\*\*([^*]+)\*\*:\s*(.+)/)
      if (m) {
        const ts = Date.parse(m[1])
        turns.push({ role: m[2].trim() === "糖糖" ? "assistant" : "user", text: m[3].trim(), timestamp: isNaN(ts) ? Date.now() : ts })
      }
    }
    log.info(`从 sessions/ 加载 ${turns.length} 轮对话:`, match)
    return turns
  } catch { return null }
}

export async function updateSessionTopic(topic: string): Promise<void> {
  if (!sessionMemory || !topic) return
  const oldName = makeSessionFilename(sessionMemory.sessionId, "新会话")
  const newName = makeSessionFilename(sessionMemory.sessionId, topic)
  if (oldName === newName) return
  try {
    const oldContent = await readSessionFile(oldName)
    if (oldContent) {
      await writeSessionFile(newName, oldContent)
      try { await invoke("file_delete", { path: `${sessionsDir}/${oldName}` }) } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

export async function deleteSessionFile(filename: string): Promise<boolean> {
  const parsedFN = parseSessionFilename(filename)
  log.info("deleteSessionFile:", filename)
  if (parsedFN && sessionMemory?.sessionId === parsedFN.sessionId) {
    log.info("deleteSessionFile: 重置 sessionMemory（当前活跃会话被删除）")
    sessionMemory = null
  }
  await invoke("delete_session_file", { filename })
  projectEntries = projectEntries.filter(e => e.sessionFile !== filename)
  log.info("会话文件已删除:", filename)
  return true
}

export async function deleteSessionAndPointer(filename: string): Promise<boolean> {
  return deleteSessionFile(filename)
}

// ── 轮次记录 ──

export let turnCounter = 0

export function recordTurn(role: "user" | "assistant", text: string, checkConsolidate: () => void): void {
  if (!sessionMemory) {
    log.warn("recordTurn: sessionMemory 为空，创建新会话记忆")
    sessionMemory = newSessionMemory()
  }
  sessionMemory.turns.push({ role, text: text.substring(0, 200), timestamp: Date.now() })
  turnCounter++
  if (turnCounter % 5 === 0) {
    log.info(`已达到 ${turnCounter} 轮，触发记忆整理`)
    checkConsolidate()
  }
  appendTurnToSessionFile(role, text).catch(e => log.warn("session 文件实时写入失败", e))
}

export async function recordTurnToSession(sessionId: string, role: "user" | "assistant", text: string): Promise<void> {
  if (!sessionsDir) { log.warn("recordTurnToSession: sessionsDir 未设置"); return }
  try {
    const files = await invoke<string[]>("list_session_files")
    const match = files.find(f => f.startsWith(sessionId))
    if (!match) { log.warn("recordTurnToSession: 未找到会话文件", sessionId); return }
    let current = await readSessionFile(match)
    if (!current || current.length < 20) { log.warn("recordTurnToSession: 文件内容为空", match); return }
    const timeStr = localTime(new Date())
    const roleLabel = role === "assistant" ? "糖糖" : "用户"
    const turnLine = `- [${timeStr}] **${roleLabel}**: ${text.substring(0, 300)}`
    const turnMatches = current.match(/^\s*-\s*\[[^\]]+\]\s*\*\*[^*]+\*\*:/gm) || []
    current = current
      .replace(/^> 轮数: \d+/m, `> 轮数: ${turnMatches.length + 1}`)
      .replace(/^## 对话记录 \(\d+ 轮\)/m, `## 对话记录 (${turnMatches.length + 1} 轮)`)
    current = current.trimEnd() + "\n" + turnLine + "\n"
    await writeSessionFile(match, current)
    log.debug(`recordTurnToSession: ${role} → ${match} (${turnMatches.length + 1} 轮)`)
  } catch (e) { log.warn("recordTurnToSession 失败", e instanceof Error ? e : undefined) }
}

export async function appendTurnToSessionFile(role: "user" | "assistant", text: string): Promise<void> {
  if (!sessionMemory) { log.warn("appendTurnToSessionFile: sessionMemory 为空"); return }
  if (!sessionsDir) { log.warn("appendTurnToSessionFile: sessionsDir 未设置"); return }
  let filename = ""
  try {
    const files = await invoke<string[]>("list_session_files")
    const match = files.find(f => f.startsWith(sessionMemory!.sessionId))
    if (match) filename = match
  } catch { /* ignore */ }
  if (!filename) {
    const topic = sessionMemory.turns.length > 0
      ? sessionMemory.turns.find(t => t.role === "user")?.text.substring(0, 20)?.replace(/[\n\r/\\:*?"<>|]/g, "").trim() || "新会话"
      : "新会话"
    filename = makeSessionFilename(sessionMemory.sessionId, topic)
  }
  try {
    let current = await readSessionFile(filename)
    let writeFilename = filename
    const timeStr = localTime(new Date())
    const roleLabel = role === "assistant" ? "糖糖" : "用户"
    const turnLine = `- [${timeStr}] **${roleLabel}**: ${text.substring(0, 300)}`
    if (!current || current.length < 20) {
      const topic = sessionMemory.turns.length > 0
        ? sessionMemory.turns.find(t => t.role === "user")?.text.substring(0, 20)?.replace(/[\n\r/\\:*?"<>|]/g, "").trim() || "新会话"
        : "新会话"
      current = [
        `# ${sessionMemory.sessionId}-${topic}`, `> 开始: ${localTime(sessionMemory.startedAt)}`, `> 轮数: 1`,
        `> Token累计: 0/0 | 上下文: 0%`, "", "## 摘要", "<!-- 归档时填充 -->", "", "## 对话记录 (1 轮)", "", turnLine, "",
      ].join("\n")
    } else {
      const turnMatches = current.match(/^\s*-\s*\[[^\]]+\]\s*\*\*[^*]+\*\*:/gm) || []
      const turnCount = turnMatches.length + 1
      const newTopic = sessionMemory.turns.find(t => t.role === "user")?.text.substring(0, 20)?.replace(/[\n\r/\\:*?"<>|]/g, "").trim() || ""
      const { debug } = await import("@/services/debug")
      const tokenLine = `> Token累计: ${debug.totalPromptTokens}/${debug.totalCompletionTokens} | 上下文: ${debug.lastContextUsage}%`
      current = current
        .replace(/^> 轮数: \d+/m, `> 轮数: ${turnCount}`)
        .replace(/^> Token累计:.*/m, tokenLine)
        .replace(/^## 对话记录 \(\d+ 轮\)/m, `## 对话记录 (${turnCount} 轮)`)
      if (!current.includes("Token累计:")) {
        current = current.replace(/^(> 轮数: \d+)/m, `$1\n${tokenLine}`)
      }
      if (newTopic && filename.includes("-新会话")) {
        current = current.replace(/^# session-\d{8}-\d{6}-新会话/m, `# ${sessionMemory.sessionId}-${newTopic}`)
        const newFilename = makeSessionFilename(sessionMemory.sessionId, newTopic)
        if (newFilename !== filename) writeFilename = newFilename
      }
      current = current.trimEnd() + "\n" + turnLine + "\n"
    }
    await writeSessionFile(writeFilename, current)
    if (writeFilename !== filename) {
      try { await invoke("file_delete", { path: `${sessionsDir}/${filename}` }) } catch { /* ignore */ }
      filename = writeFilename
    }
    const pe = projectEntries.find(e => e.sessionFile === filename)
    if (pe) {
      const turnMatches = current.match(/^\s*-\s*\[[^\]]+\]\s*\*\*[^*]+\*\*:/gm) || []
      pe.rounds = turnMatches.length
    }
  } catch (e) { log.warn("实时写入 session 文件失败", e instanceof Error ? e : undefined) }
}

// ── 压缩摘要 ──

export async function writeCompactionSummary(opts: {
  mainRequest: string; keyTech: string[]; files: string[]
  problems: string; userMessages: string[]; tasks?: string[]
  currentWork: string; nextSteps: string
}): Promise<void> {
  if (!sessionMemory) sessionMemory = newSessionMemory()
  sessionMemory.compactionSummary = { ...opts, tasks: opts.tasks ?? [], generatedAt: Date.now() }
  await _syncSessionFile()
  log.info("压缩摘要已写入 sessions/")
}

export function getCompactionSummarySync(): string {
  const cs = sessionMemory?.compactionSummary
  if (!cs) return ""
  return [
    "\n\n[会话上下文]",
    cs.mainRequest ? `主请求: ${cs.mainRequest}` : "",
    cs.keyTech.length > 0 ? `关键技术: ${cs.keyTech.join(", ")}` : "",
    cs.files.length > 0 ? `涉及文件: ${cs.files.join(", ")}` : "",
    cs.problems ? `已解决问题: ${cs.problems}` : "",
    cs.tasks.length > 0 ? `已完成任务: ${cs.tasks.join(", ")}` : "",
    cs.currentWork ? `当前工作: ${cs.currentWork}` : "",
    cs.nextSteps ? `下一步: ${cs.nextSteps}` : "",
  ].filter(l => l.length > 0).join("\n")
}

async function _syncSessionFile(): Promise<void> {
  if (!sessionMemory || !sessionsDir) return
  const filename = makeSessionFilename(sessionMemory.sessionId, findTopicFromTurns(sessionMemory.turns))
  const lines = buildSessionFileContent(sessionMemory)
  await writeSessionFile(filename, lines.join("\n"))
}

// ── 归档 ──

export async function archiveSession(): Promise<string | null> {
  if (!sessionMemory || sessionMemory.turns.length === 0) return null
  const sid = sessionMemory.sessionId
  const cs = sessionMemory.compactionSummary
  const firstUser = sessionMemory.turns.find(t => t.role === "user")
  const topic = findTopicFromTurns(sessionMemory.turns)
  const filename = makeSessionFilename(sid, topic)
  const lines = buildSessionFileContent(sessionMemory)
  lines.splice(3, 0, `> 归档: ${localTime(new Date())}`)
  const ok = await writeSessionFile(filename, lines.join("\n"))
  if (!ok) { log.error("会话归档写入失败:", filename); return null }
  projectEntries.push({
    sessionFile: filename, date: localDate(), rounds: sessionMemory.turns.length,
    mainRequest: cs?.mainRequest ?? firstUser?.text.substring(0, 50) ?? "无",
    keyTech: cs?.keyTech ?? [],
  })
  log.info(`会话已归档: sessions/${filename} (${sessionMemory.turns.length} 轮) → Project.md`)
  sessionMemory = newSessionMemory()
  return sid
}

export async function loadArchivedSession(filename: string): Promise<string | null> {
  return (await readSessionFile(filename)) || null
}

// ── Sessions 列表 ──

export async function listSessionFiles(): Promise<SessionFileMeta[]> {
  try {
    const files = await invoke<string[]>("list_session_files")
    const result: SessionFileMeta[] = []
    for (const filename of files) {
      const parsed = parseSessionFilename(filename)
      if (!parsed) continue
      const raw = await readSessionFile(filename)
      const meta = parseSessionFileMeta(raw)
      result.push({
        filename, sessionId: parsed.sessionId,
        topic: meta.topic || parsed.topic || "新会话",
        createdAt: meta.createdAt ?? "", mode: meta.mode ?? "",
        rounds: meta.rounds ?? 0, size: raw.length,
      })
    }
    return result.sort((a, b) => b.filename.localeCompare(a.filename))
  } catch (e) { log.warn("列出会话文件失败", e instanceof Error ? e : undefined); return [] }
}

// ── 访问器 ──

export function getSession(): SessionMemory | null { return sessionMemory }
export function getSessionId(): string { return sessionMemory?.sessionId ?? "" }
export function getSessionTurnCount(): number { return sessionMemory?.turns.length ?? 0 }
export function getProjectCount(): number { return projectEntries.length }
export function getSessionFilename(topic?: string): string {
  if (!sessionMemory) return ""
  return makeSessionFilename(sessionMemory.sessionId, topic)
}
