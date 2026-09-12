// src/services/paths.ts
// ==========================================
// 路径模块 — Rust 是环境判断和路径拼接的唯一真相源
// ==========================================

import { invoke } from "@tauri-apps/api/core"
import { createLogger } from "@/services/logger"

const log = createLogger("Paths")

let _inited = false

// ── Base dirs ──
let _dataDir = ""
let _memoryDir = ""
let _sessionsDir = ""
let _personalityDir = ""
let _profilesDir = ""
let _settingsDir = ""
let _configFile = ""
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
  _personalityDir = paths.personality
  _profilesDir = paths.profiles
  _settingsDir = paths.settings
  _configFile = paths.configFile
  _runtimeMode = paths.runtimeMode
  _inited = true
  log.info(`路径模块已初始化 (${_runtimeMode}):`, _dataDir)
}

// ── Base dirs（业务模块用这些拼自己的文件名）──
export const BaseDirs = {
  data:        () => _dataDir,
  memory:      () => _memoryDir,
  sessions:    () => _sessionsDir,
  personality: () => _personalityDir,
  profiles:    () => _profilesDir,
  settings:    () => _settingsDir,
  configFile:  () => _configFile,
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
