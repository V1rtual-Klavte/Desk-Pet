// ==========================================
// 记忆系统 — 文件 I/O 层
// ==========================================

import { invoke } from "@tauri-apps/api/core"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"
import { runtimePath } from "@/services/paths"

const log = createLogger("MemoryIO")

// ── 目录路径 ──
let memoryDir = ""

export function setMemoryDir(dir: string): void { memoryDir = dir }

// ── 文件写入串行化 ──
const writeTails = new Map<string, Promise<void>>()

/**
 * Serialize read-modify-write operations. The tail always recovers so one
 * failed write cannot deadlock later memory writes.
 */
export function withLock<T>(keyOrFn: string | (() => Promise<T>), maybeFn?: () => Promise<T>): Promise<T> {
  const key = typeof keyOrFn === "string" ? keyOrFn : "global"
  const fn = typeof keyOrFn === "string" ? maybeFn! : keyOrFn
  const tail = writeTails.get(key) ?? Promise.resolve()
  const run = tail.then(fn, fn)
  const recovered = run.then(() => undefined, () => undefined)
  writeTails.set(key, recovered)
  void recovered.then(() => { if (writeTails.get(key) === recovered) writeTails.delete(key) })
  return run
}

// ── Memory 文件读写 ──

/** 读记忆文件；返回空串 = 读取失败或文件不存在（调用方按空记忆继续），失败另有 warn 留痕。 */
export async function readMemoryFile(filename: string): Promise<string> {
  try {
    if (!memoryDir) return ""
    const path = await runtimePath("memory", filename)
    const result = await invoke<{ content: string; size: number }>("file_read", { path })
    return result.content
  } catch (error) {
    log.warn("记忆文件读取失败:", filename, formatError(error))
    return ""
  }
}

export async function writeMemoryFile(filename: string, content: string): Promise<boolean> {
  try {
    if (!memoryDir) { log.warn("writeMemoryFile: memoryDir 未设置"); return false }
    const path = await runtimePath("memory", filename)
    await invoke("file_write", { path, content })
    return true
  } catch (e) { log.error(`写入 ${filename} 失败: ${memoryDir}/${filename}`, e instanceof Error ? e : undefined); return false }
}
