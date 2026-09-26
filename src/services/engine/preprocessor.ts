// ==========================================
// 核心引擎 —— PreProcessor
// Slash 命令处理 + 空消息/重复消息过滤
// 所有命令统一通过 slash/registry 查找执行
// ==========================================

import { createLogger } from "@/services/logger"
import { loopConfig } from "@/services/config"
import { find } from "./slash/registry"
import type { RegisteredSlashCommand, SlashCommandResult, SlashSkillAdmission } from "./slash/types"

const log = createLogger("PreProc")

export interface PreProcessResult {
  /**
   * 是否为 slash 命令并已处理。
   * 带 `skillAdmission` 时为 false：命令已被识别，但这次输入还没结束 —— 正文由 Harness 落盘
   * （见下），由运行入口在拿到运行代际后接手。
   */
  handled: boolean
  /** 处理后应直接返回给用户的消息（slash 命令结果） */
  response?: string
  /**
   * 技能准入意图（`/skill <技能名> [额外指示]`）：命令层只声明要启动哪个技能，
   * 正文与那条 `role:"user"` 条目由 Harness 在 `accept` 内按技能文件构造并提交（先落盘再投递）。
   */
  skillAdmission?: SlashSkillAdmission
  /** 经过过滤的用户文本（空 = 跳过） */
  text: string
  rawText: string
  normalizedText: string
}

/** 命令结果里的非文本形态只有技能准入（`SlashCommandResult` 是一个联合）。 */
function isSkillAdmission(result: SlashCommandResult): result is SlashSkillAdmission {
  return typeof result === "object" && result !== null
}

export interface PreProcessState {
  lastUserText?: string
  lastUserTime?: number
}

export interface PreProcessOptions {
  /** 同会话有在飞运行：命令按 busyPolicy 准入，exclusive 的命令明确拒绝而不是丢弃。 */
  busy?: boolean
}

/** 忙碌期准入：只有 immediate / coordinated 的命令能执行，其余明确拒绝（§3.4）。 */
function busyRejection(command: RegisteredSlashCommand): string | undefined {
  const policy = command.busyPolicy ?? "exclusive"
  if (policy === "immediate" || policy === "coordinated") return undefined
  return `/${command.name} 需要等当前回合结束再执行。`
}

/**
 * 预处理用户输入 —— Slash 的唯一执行入口（ChatPanel / 运行器都经这里）。
 * - slash 命令 → 查找注册表并按 busyPolicy 执行或拒绝
 * - 空/纯空格 → 跳过
 * - 短时间重复 → 跳过（30s 内相同文本）
 */
export async function preProcess(rawText: string, state: PreProcessState = {}, options: PreProcessOptions = {}): Promise<PreProcessResult> {
  const text = rawText.trim()

  // ── 空消息 ──
  if (!text) {
    return { handled: true, text: "", rawText, normalizedText: text }
  }

  // ── Slash 命令 ──
  if (text.startsWith("/")) {
    const cmdText = text.slice(1) // 去掉开头的 /
    const hit = find(cmdText)

    if (hit) {
      const command = hit.command
      if (options.busy) {
        const rejection = busyRejection(command)
        if (rejection) {
          log.info("忙碌期拒绝命令:", command.name)
          return { handled: true, response: rejection, text: "", rawText, normalizedText: text }
        }
      }
      try {
        const result = await command.execute(hit.args)
        if (isSkillAdmission(result)) {
          // 技能准入不是「已处理的文本」：它要一次运行代际才能落盘（`accept` 在准入内提交正文），
          // 这里只把意图交出去，由运行入口接手；命令层不写会话条目、也不自己投递正文。
          return { handled: false, skillAdmission: result, text, rawText, normalizedText: text }
        }
        if (result !== null) {
          return { handled: true, response: result, text: "", rawText, normalizedText: text }
        }
        // result === null → 命令已执行但不需要显示回复
        return { handled: true, text: "", rawText, normalizedText: text }
      } catch (e) {
        log.error("命令执行失败:", cmdText, e)
        return { handled: true, response: "命令执行出错…", text: "", rawText, normalizedText: text }
      }
    }

    // / 开头但未注册的命令 → 透传给 AI（用户可能在问 "/etc 是什么"）
    log.debug("未注册的 slash 输入，透传 AI:", cmdText)
    return { handled: false, text, rawText, normalizedText: text }
  }

  // ── 去重 ──
  const now = Date.now()
  if (text === state.lastUserText && now - (state.lastUserTime ?? 0) < loopConfig.dedupWindowMs) {
    log.debug("重复消息过滤")
    return { handled: true, text: "", rawText, normalizedText: text }
  }
  state.lastUserText = text
  state.lastUserTime = now

  return { handled: false, text, rawText, normalizedText: text }
}
