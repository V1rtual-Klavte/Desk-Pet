// src/services/paths.ts
// ==========================================
// 路径模块 — 从 Rust 拿 base dir，业务模块自己拼文件名
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

export async function initPaths(): Promise<void> {
  if (_inited) return
  try {
    _dataDir        = await invoke<string>("get_data_dir")
    _memoryDir      = await invoke<string>("get_memory_dir")
    _sessionsDir    = await invoke<string>("get_sessions_dir")
    _personalityDir = await invoke<string>("get_personality_dir")
    _profilesDir    = await invoke<string>("get_profiles_dir")
    _inited = true
    log.info("路径模块已初始化:", _dataDir)
  } catch (e) {
    log.error("路径初始化失败", e)
  }
}

// ── Base dirs（业务模块用这些拼自己的文件名）──
export const BaseDirs = {
  data:        () => _dataDir,
  memory:      () => _memoryDir,
  sessions:    () => _sessionsDir,
  personality: () => _personalityDir,
  profiles:    () => _profilesDir,
}

/** 内置 profile 的 URL 前缀 */
export const BUILTIN_PROFILES_URL = "/profiles"
export const DEFAULT_PROFILE = "sugar-pink"
