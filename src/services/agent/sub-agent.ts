// ==========================================
// 子代理 —— Fork（单代理）/ Team（多角色并行）
// ==========================================

import type { ToolDef } from "@/services/tool/types"
import { getToolsForMode } from "@/services/tool/registry"
import { runSubLoop } from "./sub-loop"
import type { SubLoopOutput } from "./sub-loop"
import { createLogger } from "@/services/logger"

const log = createLogger("SubAgent")

// ═══════════════════════════════════════════════════════════════
// ForkAgent —— 单个子代理执行独立任务
// ═══════════════════════════════════════════════════════════════

export interface ForkAgentInput {
  task: string
  /** 可选的角色提示（如 "代码审查员"），用于定制 systemPrompt */
  role?: string
}

/**
 * 创建并运行一个 Fork 子代理。
 * 子代理拥有精简的工具集（只读文件+系统信息+Bash白名单+HTTP），
 * 独立上下文，不干扰主 Agent 状态。
 */
export async function runForkAgent(input: ForkAgentInput): Promise<SubLoopOutput> {
  const { task, role } = input

  const tools = getSafeTools()
  const systemPrompt = role
    ? `你是糖糖桌宠的子代理，角色: ${role}。用简短中文回复，可以调用工具获取信息。`
    : "你是糖糖桌宠的子代理。用简短中文回复，可以调用工具获取信息。只做查询类操作，不要修改文件。"

  log.info("Fork 启动:", role || "通用", "| task:", task.substring(0, 80))

  return runSubLoop({
    task,
    tools,
    systemPrompt,
    maxRounds: 3,
    timeoutMs: 90000,
  })
}

// ═══════════════════════════════════════════════════════════════
// TeamAgent —— 多角色并行子代理
// ═══════════════════════════════════════════════════════════════

export interface TeamAgentInput {
  task: string
  /** 并行子代理数量，默认 2 */
  memberCount?: number
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
export async function runTeamAgent(input: TeamAgentInput): Promise<string> {
  const { task, memberCount = 2 } = input

  const roles = TEAM_ROLES.slice(0, Math.min(memberCount, TEAM_ROLES.length))

  log.info("Team 启动:", roles.length, "个成员", "| task:", task.substring(0, 80))

  // ── Phase 1: 所有成员并行运行 ──
  const memberResults = await Promise.allSettled(
    roles.map(role =>
      runForkAgent({
        task: `${role.prompt}\n\n任务: ${task}`,
        role: role.label,
      })
    )
  )

  const reports: { role: string; reply: string }[] = []
  for (let i = 0; i < memberResults.length; i++) {
    const r = memberResults[i]
    const role = roles[i]
    if (r.status === "fulfilled" && r.value.success) {
      reports.push({ role: role.label, reply: r.value.reply })
    } else if (r.status === "rejected") {
      reports.push({ role: role.label, reply: `执行失败: ${String(r.reason)}` })
    }
  }

  if (reports.length === 0) {
    return "Team 执行失败: 所有成员均未返回结果"
  }

  // ── Phase 2: Lead 代理汇总 ──
  const leadPrompt = [
    "你是团队负责人，请基于以下成员报告，给出最终的综合结论。",
    `原始任务: ${task}`,
    "",
    ...reports.map((r, i) => `[成员${i + 1}: ${r.role}]\n${r.reply}`),
    "",
    "请用简短中文总结团队结论。",
  ].join("\n")

  const leadResult = await runForkAgent({
    task: leadPrompt,
    role: "团队负责人",
  })

  const header = `🤝 Team 结果 (${reports.length} 位成员)\n`
  const body = reports.map((r, i) =>
    `${i + 1}. **${r.role}**: ${r.reply.substring(0, 150)}`
  ).join("\n")
  const footer = `\n\n📋 综合结论:\n${leadResult.reply}`

  log.info("Team 完成:", reports.length, "成员")
  return header + body + (body.length + footer.length < 2000 ? footer : "\n\n(结论过长已截断)")
}

// ═══════════════════════════════════════════════════════════════
// 工具集 —— 子代理可用工具（只读安全集）
// ═══════════════════════════════════════════════════════════════

/** 子代理可用工具 ID 白名单（只读 + 安全） */
const SUB_AGENT_TOOL_IDS = new Set([
  "local-file-read",
  "local-file-list",
  "local-file-search",
  "local-system-info",
  "local-bash",
  "local-http-get",
])

/** 获取子代理的可用工具 */
function getSafeTools(): ToolDef[] {
  const allTools = getToolsForMode("pet") // 轻量模式工具
  return allTools.filter(t => SUB_AGENT_TOOL_IDS.has(t.id))
}

// ═══════════════════════════════════════════════════════════════
// HMR
// ═══════════════════════════════════════════════════════════════
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    log.info("SubAgent HMR 完成")
  })
}
