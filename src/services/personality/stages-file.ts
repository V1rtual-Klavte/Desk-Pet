// ==========================================
// stages/{cardId}.json — 唯一读写入口
//   stages 段唯一生产者 = stages-cache；variables 段唯一生产者 = variable-pool
//   路径、格式、合并语义、损坏容错只此一份
// ==========================================

import type { VariableState } from "./types"
import { createLogger } from "@/services/logger"
import { errorCode, formatError } from "@/services/error"

const log = createLogger("StagesFile")

/** 当前文件 schema；两段共享同一个版本号 */
export const STAGES_FILE_SCHEMA_VERSION = 2

// ── 文件形态类型 ──

/** 阶段文案段 —— stages 段的唯一形态 */
export interface StageFileStages {
  cardId: string
  /** 仅元数据/诊断，不参与失效判定（判定键是 sourceHash，见 stages-cache 的 stageSourceHash） */
  cardVersion: number
  /** SHA-256(roleSetting + "\n" + languageStyle) */
  sourceHash: string
  generatedAt: number
  isFallback: boolean
  stages: StageMap
}

/** 变量状态段 —— variables 段的唯一形态 */
export interface StageFileVariables {
  schemaVersion: number
  updatedAt: number
  card: Record<string, VariableState>
  interaction: Record<string, VariableState>
  /** reset: "daily" 的「已应用」日期键（YYYY-MM-DD，本地日期） */
  lastDailyResetKey?: string
  /** reset: "session" 的「已应用」会话键（SessionMeta.createdAt 毫秒） */
  sessionKey?: number
}

export interface StagesFile {
  schemaVersion: number
  stages?: StageFileStages
  variables?: StageFileVariables
}

/** 阶段文案的内存形态与文件形态同构 —— 保留既有 import 名 */
export type StagePrompts = StageFileStages

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
  /** 系统兜底回复，每个 Card 有自己的角色化版本 */
  fallbacks: FallbackReplies
  /** 首次激活的问候语，每个 Card 有自己的角色化版本；运行时随机选一条 */
  greetings: string[]
}

/** 系统兜底回复类型 — 替代硬编码中文 */
export interface FallbackReplies {
  concurrentRejected: string
  maxRetriesExhausted: string
  turnTimeout: string
  toolLoopMaxRounds: string
  llmUnavailable: string[]        // 数组，运行时随机选一条
  subAgentDone: string
  subAgentFailed: string
  subAgentNoResult: string
  compactionFailed: string
}

// ── 读写 ──

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** 损坏时统一留证并抛出：调用方决定是显式降级还是按段重建 */
function corrupt(cardId: string, detail: string): Error {
  const error = new Error(detail)
  log.error("stages 文件损坏:", cardId, formatError(error))
  return error
}

/**
 * 读取 stages/{cardId}.json。
 * 仅 PATH_NOT_FOUND 返 null；JSON 损坏或形状非法 → log.error 后抛出（不静默降级）。
 * 路径是**域内相对路径**：base 目录由 Rust 的 AppPaths 持有，不得加 `personality/` 前缀。
 */
export async function readStagesFile(cardId: string): Promise<StagesFile | null> {
  const { invoke } = await import("@tauri-apps/api/core")

  let raw: number[]
  try {
    raw = await invoke<number[]>("personality_file_read", { path: `stages/${cardId}.json` })
  } catch (e) {
    if (errorCode(e) === "PATH_NOT_FOUND") {
      log.debug("stages 文件不存在:", cardId)
      return null
    }
    throw e
  }

  const json = new TextDecoder().decode(new Uint8Array(raw))
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (e) {
    log.error("stages 文件损坏:", cardId, formatError(e))
    throw e
  }

  if (!isPlainObject(parsed)) throw corrupt(cardId, "顶层不是 JSON 对象")
  for (const section of ["stages", "variables"] as const) {
    const value = parsed[section]
    if (value !== undefined && !isPlainObject(value)) throw corrupt(cardId, `${section} 段不是对象`)
  }
  return parsed as unknown as StagesFile
}

/**
 * 读 → 合并 patch → 写，返回写入的绝对路径。
 * 段级合并：patch 里没给的段保留原值（两个段各有唯一生产者，互不抹除）。
 * 文件损坏时 log.error 后按段重建；Rust 写入非原子，崩溃半写就靠这条分支收口。
 */
export async function updateStagesFile(
  cardId: string,
  patch: Partial<Pick<StagesFile, "stages" | "variables">>,
): Promise<string> {
  const empty: StagesFile = { schemaVersion: STAGES_FILE_SCHEMA_VERSION }
  let base: StagesFile
  try {
    base = await readStagesFile(cardId) ?? empty
  } catch (e) {
    log.error("stages 文件损坏，按段重建:", cardId, formatError(e))
    base = empty
  }

  const next: StagesFile = {
    schemaVersion: STAGES_FILE_SCHEMA_VERSION,
    stages: patch.stages ?? base.stages,
    variables: patch.variables ?? base.variables,
  }

  const { invoke } = await import("@tauri-apps/api/core")
  const content = new TextEncoder().encode(JSON.stringify(next, null, 2))
  return await invoke<string>("personality_file_write", {
    path: `stages/${cardId}.json`,
    content: Array.from(content),
  })
}
