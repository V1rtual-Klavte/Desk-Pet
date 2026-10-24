// ==========================================
// 子代理 —— Fork（单代理）/ Team（多角度并行）
//
// 注意：runPiSubAgent 的 `maxToolCalls` 是工具轮上限（工具调用次数），映射到
// createTurnSpec 的 maxToolCalls；它不是重试次数，取值为 loopConfig.subAgentRounds。
// 主聊天回合已取消计数上限（2026-10-06 起走循环病理检测），这里的封顶保留 ——
// 子代理无人值守，上限下沉到子运行范围（契约 Part 1）。
//
// 时间预算（2026-10-06 裁决）：子运行保留 90s 硬墙钟，不放宽 —— 主流 harness 的墙钟
// 只出现在无人值守范围（Gemini 子代理、Codex one-shot 之外）。由此得到一个有意的派生
// 上限：子运行内 bash 的实际上限 = 子运行预算（90s，取 min(工具档位 300s, 子运行预算)），
// 与主回合（600s）刻意不同档；该口径写在 docs/current/tool-system.md 的「文件、命令与取消」段。
// 运行墙钟的唯一定义点是 `./timeouts.ts`（`SUB_AGENT_RUN_TIMEOUT_MS`），执行侧与
// `agent_spawn` 的声明侧共用同一值，不在两处各写一个字面量。
// ==========================================

import { listAll, type ToolDef } from "@/services/tool"
import { runPiSubAgent } from "@/services/engine/harness"
import type { PiSubAgentOutput, PiSubAgentOwner } from "@/services/engine/harness"
import { loopConfig } from "@/services/config"
import { SUB_AGENT_RUN_TIMEOUT_MS } from "./timeouts"
import { formatError } from "@/services/error"
import { createLogger } from "@/services/logger"

const log = createLogger("SubAgent")

// ═══════════════════════════════════════════════════════════════
// ForkAgent —— 单个子代理执行独立任务
// ═══════════════════════════════════════════════════════════════

export interface ForkAgentInput {
  task: string
  /** 可选的角色提示（如 "代码审查员"），用于定制 systemPrompt */
  role?: string
  /** 父回合的取消域（agent_spawn 从工具上下文构造）：父取消/切会话立刻级联到子运行。 */
  owner: Extract<PiSubAgentOwner, { kind: "conversation" }>
}

/**
 * 创建并运行一个 Fork 子代理。
 * 子代理的工具面在此收窄为 read、系统信息与 bash（SUB_AGENT_TOOL_IDS；
 * bash 可执行命令，受权限策略约束），独立上下文，不干扰主 Agent 状态。
 */
export async function runForkAgent(input: ForkAgentInput): Promise<PiSubAgentOutput> {
  const { task, role, owner } = input

  const tools = getSafeTools()
  const systemPrompt = role
    ? `你是虚拟桌宠的子代理，角色: ${role}。用简短中文回复，可以调用工具获取信息。`
    : "你是虚拟桌宠的子代理。用简短中文回复，可以调用工具获取信息。工具面限于 read、系统信息与 bash（bash 可执行命令，受权限策略约束）。"

  log.info("Fork 启动:", role || "通用", "| task:", task.substring(0, 80))

  return runPiSubAgent({
    task,
    tools,
    systemPrompt,
    maxToolCalls: loopConfig.subAgentRounds,
    timeoutMs: SUB_AGENT_RUN_TIMEOUT_MS,
    owner,
  })
}

// ═══════════════════════════════════════════════════════════════
// TeamAgent —— 多角度并行子代理
// ═══════════════════════════════════════════════════════════════

export interface TeamAgentInput {
  task: string
  /** 2–3 个并行分析角度；未提供时取默认角度的前 2 个。 */
  angles?: string[]
  /** 父回合的取消域；成员段与 lead 段共用（任一段被父取消即整体停止）。 */
  owner: Extract<PiSubAgentOwner, { kind: "conversation" }>
}

/** 默认团队角度（未提供 angles 时按顺序取前 2 个）。 */
const TEAM_ANGLES = [
  { label: "约束与风险", prompt: "列出关键约束、假设与潜在风险，并指出哪些需要用户确认。" },
  { label: "事实与证据", prompt: "用工具核实事实，给出可核查的证据；没有证据的结论要标明。" },
  { label: "完整性与反例", prompt: "检查方案的遗漏、边界和反例，指出最可能出错的地方。" },
]

const TEAM_ANGLE_ERROR = "团队角度需要 2–3 个非空且不重复的描述"

interface TeamAngle {
  label: string
  prompt: string
}

/** 团队角度校验与规范化：默认角度取 label，自定义角度按顺序标为「角度 N」。 */
function resolveTeamAngles(angles?: string[]): TeamAngle[] {
  if (angles === undefined) return TEAM_ANGLES.slice(0, 2)
  if (!Array.isArray(angles) || angles.length < 2 || angles.length > 3) throw new Error(TEAM_ANGLE_ERROR)
  const prompts = angles.map(angle => typeof angle === "string" ? angle.trim() : "")
  if (prompts.some(prompt => !prompt) || new Set(prompts).size !== prompts.length) throw new Error(TEAM_ANGLE_ERROR)
  return prompts.map((prompt, index) => ({ label: `角度 ${index + 1}`, prompt }))
}

/**
 * 创建并运行 Team 子代理。
 * 各角度并行执行，最后由 lead 按角度逐项汇总；部分角度失败时保留可用结论。
 */
export async function runTeamAgent(input: TeamAgentInput): Promise<PiSubAgentOutput> {
  const { task, owner } = input
  const angles = resolveTeamAngles(input.angles)
  const results = await Promise.allSettled(angles.map((angle, index) => runForkAgent({
    task: `${angle.prompt}\n\n任务: ${task}`, role: angle.label,
    owner: { ...owner, runId: `${owner.runId}-angle-${index + 1}` },
  })))
  const members = results.map((result, index) => ({
    role: angles[index]!.label,
    output: result.status === "fulfilled" ? result.value : {
      status: "failed" as const, success: false, reply: "", toolCallsMade: 0,
      error: formatError(result.reason),
      evidence: { tools: [], incomplete: [angles[index]!.label], unconfirmedEffects: false },
      audit: { runId: `${owner.runId}-angle-${index + 1}`, requestId: `sub-agent-${owner.runId}-angle-${index + 1}`, ownerKind: owner.kind, sessionId: owner.sessionId },
    },
  }))
  const incomplete = members.filter(member => !member.output.success).map(member => member.role)
  const usable = members.filter(member => member.output.success)
  const cancelled = owner.signal?.aborted || !owner.isCurrent()
  if (cancelled || !usable.length) {
    const failed = members.find(member => member.output.status === "cancelled")?.output ?? members[0]!.output
    return {
      ...failed, status: cancelled ? "cancelled" : failed.status === "completed" ? "failed" : failed.status,
      success: false, members,
      error: cancelled ? "团队已取消" : "团队所有成员均未完成任务",
      evidence: { tools: members.flatMap(member => member.output.evidence.tools), incomplete, unconfirmedEffects: members.some(member => member.output.evidence.unconfirmedEffects) },
    }
  }
  const lead = await runForkAgent({
    task: [
      "你是团队负责人，按角度逐项汇总成员的真实结果：每个角度列出 label、status、success 与结果（reply 或 error）；未完成的角度必须明确说明，不得补写未完成角度的内容。",
      `原始任务: ${task}`,
      ...members.map(member => `[角度: ${member.role} | status: ${member.output.status} | success=${member.output.success}]\n${member.output.reply || member.output.error || "无结果"}`),
    ].join("\n\n"),
    role: "团队负责人", owner: { ...owner, runId: `${owner.runId}-lead` },
  })
  const usage = [...members.map(member => member.output), lead].reduce((sum, result) => ({
    inputTokens: sum.inputTokens + (result.usage?.inputTokens ?? 0),
    outputTokens: sum.outputTokens + (result.usage?.outputTokens ?? 0),
    cacheRead: sum.cacheRead + (result.usage?.cacheRead ?? 0), cacheWrite: sum.cacheWrite + (result.usage?.cacheWrite ?? 0),
  }), { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 })
  const success = lead.success && usable.length > 0
  log.info("Team 完成:", { angles: angles.length, success, incomplete })
  return {
    ...lead, success, members, usage,
    toolCallsMade: lead.toolCallsMade + members.reduce((sum, member) => sum + member.output.toolCallsMade, 0),
    // lead 失败给出它自己的错误；lead 成功但没有任何可用角度时，如实说「没有可用结果」，
    // 不把成员全失败说成「汇总失败」。
    ...(success ? {} : { error: lead.error ?? "团队没有可用的角度结果" }),
    evidence: {
      tools: [...members.flatMap(member => member.output.evidence.tools), ...lead.evidence.tools],
      incomplete: [...incomplete, ...lead.evidence.incomplete],
      unconfirmedEffects: lead.evidence.unconfirmedEffects || members.some(member => member.output.evidence.unconfirmedEffects),
    },
  }
}

// ═══════════════════════════════════════════════════════════════
// 工具集 —— 子代理可用工具（read + system info + bash）
// ═══════════════════════════════════════════════════════════════

/** 子代理可用工具 ID 白名单：read + system info + bash（bash 可执行命令，受权限策略约束） */
const SUB_AGENT_TOOL_IDS = new Set([
  "pi-read",
  "local-system-info",
  "pi-bash",
])

/** 获取子代理的可用工具：全部已注册工具按固定白名单收窄。 */
function getSafeTools(): ToolDef[] {
  const allTools = listAll()
  return allTools.filter(t => SUB_AGENT_TOOL_IDS.has(t.id))
}
