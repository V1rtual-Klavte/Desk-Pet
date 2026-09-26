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
  /** 回合开始、尚未产出可见内容时的状态行提示 */
  thinking: string | null
  planning: string | null
  executing: Record<string, string>
  done: Record<string, string>
  blocked: Record<string, string>
  error: string
  /** Harness RetryPolicy 重试等待中的状态行提示（不是重试耗尽后的兜底回复，那是 fallbacks.maxRetriesExhausted） */
  retry: string
  /** slash 命令的用户可见输出，每个 Card 有自己的角色化版本 */
  commands: CommandReplies
  /** 系统兜底回复，每个 Card 有自己的角色化版本 */
  fallbacks: FallbackReplies
  /** 首次激活的问候语，每个 Card 有自己的角色化版本；运行时随机选一条 */
  greetings: string[]
}

/**
 * slash 命令输出 —— 只覆盖语义固定的终态句。
 * 带计数/错误插值的拼接句（如「还有 N 条排队消息」）留中性：插值内容本身是诊断事实，
 * 角色化只会让用户分不清「命令没跑成」和「角色在说话」。
 */
export interface CommandReplies {
  clear: string
  memoryCleared: string
  compactCompleted: string
  compactDeclined: string
  compactNothing: string
  compactBusy: string
  compactClosed: string
  /** 排队项未清空时的指引句；条数与投递意图分类由命令层作中性明细附在其后 */
  compactPending: string
  /** 压缩失败（上游内核报错）。技术原因由命令层附在其后，不在这里顶替 */
  compactFailed: string
  // /skill 的终态句 —— 技能名与「未知 / 无正文 / 被关闭」的诊断事实由命令层作中性明细附在句后，
  // 不写进这几个 key：插值内容是诊断事实，角色化会让用户分不清「角色在说话」和「命令没跑成」
  /** 显式调用成功：技能已加入本次对话 */
  skillStarted: string
  /** 指定的技能名不存在 */
  skillUnknown: string
  /** 技能存在但没有可用的正文内容 */
  skillEmpty: string
  /** 技能存在但被用户关闭（frontmatter enabled: false） */
  skillDisabled: string
}

/** 系统兜底回复类型 — 替代硬编码中文 */
export interface FallbackReplies {
  concurrentRejected: string
  maxRetriesExhausted: string
  /** 回合超时的展示文案；超时是终态，由它承担（没有第二个 StageMap.timeout） */
  turnTimeout: string
  toolLoopMaxRounds: string
  llmUnavailable: string[]        // 数组，运行时随机选一条
  subAgentDone: string
  subAgentFailed: string
  subAgentNoResult: string
  /** 上次运行中断，等待用户选择继续或丢弃 */
  runInterrupted: string
  /** 压缩进行中拒绝投递新输入 */
  compactionRejected: string
  /** 停止归还的暂停输入没能放回队列 */
  pausedReturnFailed: string
  /** 计划被用户/确认通道取消 */
  planCancelled: string
  /** 计划剩余步骤执行完成 */
  planCompleted: string
  /** 继续计划时会话正忙 */
  planResumeBusy: string
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
