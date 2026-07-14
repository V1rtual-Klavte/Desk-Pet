// ==========================================
// 记忆系统 — 文件 I/O 层
// ==========================================

import { invoke } from "@tauri-apps/api/core"
import { createLogger } from "@/services/logger"
import { BaseDirs } from "@/services/paths"

const log = createLogger("MemoryIO")

// ── 目录路径 ──
export let memoryDir = ""
export let sessionsDir = ""

export function setMemoryDir(dir: string): void { memoryDir = dir }
export function setSessionsDir(dir: string): void { sessionsDir = dir }

/** 获取 memory 目录（优先已设置的值，fallback BaseDirs） */
export function getMemoryDir(): string {
  return memoryDir || BaseDirs.memory()
}

/** 获取 sessions 目录（优先已设置的值，fallback BaseDirs） */
export function getSessionsDir(): string {
  return sessionsDir || BaseDirs.sessions()
}

// ── 文件锁 ──
let lockHeld = false
const LOCK_TIMEOUT = 5000

export async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const start = Date.now()
  while (lockHeld && Date.now() - start < LOCK_TIMEOUT) {
    await new Promise(r => setTimeout(r, 50))
  }
  lockHeld = true
  try { return await fn() }
  finally { lockHeld = false }
}

// ── Memory 文件读写 ──

export async function readMemoryFile(filename: string): Promise<string> {
  try {
    if (!memoryDir) return ""
    const result = await invoke<{ content: string; size: number }>("file_read", { path: `${memoryDir}/${filename}` })
    return result.content
  } catch { return "" }
}

export async function writeMemoryFile(filename: string, content: string): Promise<boolean> {
  try {
    if (!memoryDir) { log.warn("writeMemoryFile: memoryDir 未设置"); return false }
    const path = `${memoryDir}/${filename}`
    await invoke("file_write", { path, content })
    return true
  } catch (e) { log.error(`写入 ${filename} 失败: ${memoryDir}/${filename}`, e instanceof Error ? e : undefined); return false }
}

// ── Session 文件读写 ──

export async function readSessionFile(filename: string): Promise<string> {
  try {
    if (!sessionsDir) return ""
    const result = await invoke<{ content: string; size: number }>("file_read", { path: `${sessionsDir}/${filename}` })
    return result.content
  } catch { return "" }
}

export async function writeSessionFile(filename: string, content: string): Promise<boolean> {
  try {
    if (!sessionsDir) { log.warn("writeSessionFile: sessionsDir 未设置"); return false }
    const path = `${sessionsDir}/${filename}`
    await invoke("file_write", { path, content })
    log.debug("Session 文件已写入:", filename, `(${content.length} bytes)`)
    return true
  } catch (e) { log.error(`写入 sessions/${filename} 失败: ${sessionsDir}`, e instanceof Error ? e : undefined); return false }
}
