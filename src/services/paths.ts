// src/services/paths.ts
// ==========================================
// 路径模块 — Rust 是环境判断和路径拼接的唯一真相源
// ==========================================

import { invoke } from "@tauri-apps/api/core"
import { createLogger } from "@/services/logger"

const log = createLogger("Paths")

let _inited = false

// ── Base dirs ──
// `personality` / `settings` / `configFile` 不在这里缓存：BaseDirs 只暴露真正被
// 外部读取的目录，这三个没有消费者，需要绝对路径的场景一律走 runtimePath()。
let _dataDir = ""
let _memoryDir = ""
let _sessionsDir = ""
let _profilesDir = ""
let _runtimeMode: "development" | "production" = "development"

interface RuntimePathsPayload {
  data: string
  memory: string
  sessions: string
  personality: string
  profiles: string
  settings: string
  configFile: string
  runtimeMode: "development" | "production"
}

export async function initPaths(): Promise<void> {
  if (_inited) return
  const paths = await invoke<RuntimePathsPayload>("get_runtime_paths")
  _dataDir = paths.data
  _memoryDir = paths.memory
  _sessionsDir = paths.sessions
  _profilesDir = paths.profiles
  _runtimeMode = paths.runtimeMode
  _inited = true
  log.info(`路径模块已初始化 (${_runtimeMode}):`, _dataDir)
}

// ── Base dirs（业务模块用这些拼自己的文件名）──
/**
 * 只暴露**真正被读取**的目录。
 *
 * 需要绝对路径时用 `runtimePath(scope, ...segments)`，由 Rust 拼接并校验；
 * `getRuntimeMode()` 是路径环境的唯一入口（Rust `cfg!(debug_assertions)` 裁定），
 * 不要用 `import.meta.env.DEV` 代替 —— 那是前端构建模式，两者概念不同。
 */
export const BaseDirs = {
  memory:   () => _memoryDir,
  sessions: () => _sessionsDir,
  profiles: () => _profilesDir,
}

export type RuntimePathScope = "data" | "memory" | "sessions" | "personality" | "profiles" | "settings"

export async function runtimePath(scope: RuntimePathScope, ...segments: string[]): Promise<string> {
  if (!_inited) throw new Error("路径模块尚未初始化")
  return invoke<string>("resolve_runtime_path", { scope, segments })
}

export function getRuntimeMode(): "development" | "production" {
  if (!_inited) throw new Error("路径模块尚未初始化")
  return _runtimeMode
}

export const DEFAULT_PROFILE = "sugar-pink"
