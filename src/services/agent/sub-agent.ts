// ==========================================
// 子代理 —— Fork（单代理）/ Team（多角色并行）
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
 * 子代理的工具面在此收窄为文件读取、系统信息与 Bash（SUB_AGENT_TOOL_IDS），
 * 独立上下文，不干扰主 Agent 状态。
 */
export async function runForkAgent(input: ForkAgentInput): Promise<PiSubAgentOutput> {
  const { task, role, owner } = input

  const tools = getSafeTools()
  const systemPrompt = role
    ? `你是虚拟桌宠的子代理，角色: ${role}。用简短中文回复，可以调用工具获取信息。`
    : "你是虚拟桌宠的子代理。用简短中文回复，可以调用工具获取信息。工具面限于文件读取、系统信息与 Bash，以只读查询为主。"

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
// TeamAgent —— 多角色并行子代理
// ═══════════════════════════════════════════════════════════════

export interface TeamAgentInput {
  task: string
  /** 并行子代理数量，默认 2 */
  memberCount?: number
  /** 父回合的取消域；成员段与 lead 段共用（任一段被父取消即整体停止）。 */
  owner: Extract<PiSubAgentOwner, { kind: "conversation" }>
}

/** 团队角色定义 */
const TEAM_ROLES = [
  { key: "analyzer",  label: "分析员", prompt: "你从宏观角度分析问题，梳理关键点和约束条件。" },
  { key: "researcher", label: "研究员", prompt: "你负责收集具体信息，用工具查找文件和系统状态。" },
  { key: "reviewer",   label: "审查员", prompt: "你检查方案的完整性和潜在风险，提出改进建议。" },
]

/**
 * 创建并运行 Team 子代理。
 * 多角色并行执行各自的分析，最后由 lead 代理汇总。
 */
export async function runTeamAgent(input: TeamAgentInput): Promise<PiSubAgentOutput> {
  const { task, owner } = input
  const memberCount = Number.isSafeInteger(input.memberCount) && input.memberCount! > 0 ? Math.min(input.memberCount!, TEAM_ROLES.length) : 2
  const roles = TEAM_ROLES.slice(0, memberCount)
  const results = await Promise.allSettled(roles.map(role => runForkAgent({
    task: `${role.prompt}\n\n任务: ${task}`, role: role.label,
    owner: { ...owner, runId: `${owner.runId}-${role.key}` },
  })))
  const members = results.map((result, index) => ({
    role: roles[index]!.label,
    output: result.status === "fulfilled" ? result.value : {
      status: "failed" as const, success: false, reply: "", toolCallsMade: 0,
      error: formatError(result.reason),
      evidence: { tools: [], incomplete: [roles[index]!.label], unconfirmedEffects: false },
      audit: { runId: `${owner.runId}-${roles[index]!.key}`, requestId: `sub-agent-${owner.runId}-${roles[index]!.key}`, ownerKind: owner.kind, sessionId: owner.sessionId },
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
    task: ["你是团队负责人，基于成员的真实状态给出综合结论；未完成部分必须明确说明。", `原始任务: ${task}`,
      ...members.map(member => `[${member.role}: ${member.output.status}, success=${member.output.success}]\n${member.output.reply || member.output.error || "无结果"}`),
    ].join("\n\n"),
    role: "团队负责人", owner: { ...owner, runId: `${owner.runId}-lead` },
  })
  const usage = [...members.map(member => member.output), lead].reduce((sum, result) => ({
    inputTokens: sum.inputTokens + (result.usage?.inputTokens ?? 0),
    outputTokens: sum.outputTokens + (result.usage?.outputTokens ?? 0),
    cacheRead: sum.cacheRead + (result.usage?.cacheRead ?? 0), cacheWrite: sum.cacheWrite + (result.usage?.cacheWrite ?? 0),
  }), { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 })
  const success = lead.success && incomplete.length === 0
  log.info("Team 完成:", { members: members.length, success, incomplete })
  return {
    ...lead, success, members, usage,
    toolCallsMade: lead.toolCallsMade + members.reduce((sum, member) => sum + member.output.toolCallsMade, 0),
    ...(success ? {} : { error: lead.error ?? `团队部分完成，未完成成员: ${incomplete.join("、")}` }),
    evidence: {
      tools: [...members.flatMap(member => member.output.evidence.tools), ...lead.evidence.tools],
      incomplete: [...incomplete, ...lead.evidence.incomplete],
      unconfirmedEffects: lead.evidence.unconfirmedEffects || members.some(member => member.output.evidence.unconfirmedEffects),
    },
  }
}

// ═══════════════════════════════════════════════════════════════
// 工具集 —— 子代理可用工具（只读安全集）
// ═══════════════════════════════════════════════════════════════

/** 子代理可用工具 ID 白名单（只读 + 安全） */
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
