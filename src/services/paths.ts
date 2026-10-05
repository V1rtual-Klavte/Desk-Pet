// src/services/paths.ts
// ==========================================
// 路径模块 — Rust 是环境判断和路径拼接的唯一真相源
// ==========================================

import { getHostBridge } from "@/services/host"
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

/** `get_runtime_paths` 的回执（HostCommandMap 复用本类型，见 @/services/host）。 */
export interface RuntimePathsPayload {
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
  const paths = await getHostBridge().request("get_runtime_paths", {})
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
  return getHostBridge().request("resolve_runtime_path", { scope, segments })
}

export function getRuntimeMode(): "development" | "production" {
  if (!_inited) throw new Error("路径模块尚未初始化")
  return _runtimeMode
}

// ── 纯路径文本工具（零依赖）──
// 跨域共用：分隔符归一与「取根内相对路径」只在这里实现一次，
// 各模块不再自行 `replace(/\\/g, "/")` 或手工 slice 前缀。

/** `\` → `/`；只做分隔符归一，不解析、不查盘。 */
export function normalizeSeparators(path: string): string {
  return path.replace(/\\/g, "/")
}

/** 取 `full` 在 `root` 内的相对路径（`/` 分隔）；不在 root 内（含等于 root）返回 null。 */
export function relativeWithinRoot(root: string, full: string): string | null {
  const base = normalizeSeparators(root).replace(/\/+$/, "")
  const target = normalizeSeparators(full)
  if (!target.startsWith(`${base}/`)) return null
  return target.slice(base.length + 1)
}

export const DEFAULT_PROFILE = "sugar-pink"
