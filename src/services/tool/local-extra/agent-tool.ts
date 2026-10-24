// ==========================================
// 本地工具：子代理 (DANGER)
// Fork: 单个子代理独立执行任务
// Team: 多角度并行分析 + lead 汇总
// ==========================================

import type { ToolDef } from "../types"
import { TOOL_POLICY_VERSION } from "../types"
import { defineTool } from "../policy"
import { register } from "../registry"
import { AGENT_SPAWN_TOOL_TIMEOUT_MS } from "@/services/agent/timeouts"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("ToolAgent")

const TEAM_ANGLE_ERROR = "团队角度需要 2–3 个非空且不重复的描述"

/** 工具层参数校验：未提供返回空对象；非法形态返回错误（与 team 子运行的领域校验同口径）。 */
function parseTeamAngles(raw: unknown): { angles?: string[]; error?: string } {
  if (raw === undefined) return {}
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 3) return { error: TEAM_ANGLE_ERROR }
  const angles = raw.map(angle => typeof angle === "string" ? angle.trim() : "")
  if (angles.some(angle => !angle) || new Set(angles).size !== angles.length) return { error: TEAM_ANGLE_ERROR }
  return { angles }
}

const agentSpawnTool: ToolDef = defineTool({
  id: "local-agent-spawn",
  name: "agent_spawn",
  description:
    "创建子代理执行独立任务。mode=fork 时创建一个子代理独立工作；mode=team 时并行 2–3 个角度分析后汇总，可用 angles 指定角度。子代理可使用 read、系统信息与 bash（bash 可执行命令，受权限策略约束），不继承父代理的其余工具。部分角度失败时仍返回可用结论并标注。",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "子代理的任务描述，越具体越好" },
      mode: {
        type: "string",
        description: "子代理模式：fork=单个代理独立工作, team=多角度并行分析后汇总",
        enum: ["fork", "team"],
      },
      angles: {
        type: "array",
        items: { type: "string" },
        minItems: 2,
        maxItems: 3,
        description: "仅 team 模式可用：2–3 个并行分析角度；未提供时使用默认角度的前两个",
      },
    },
    required: ["task"],
  },
  safetyLevel: "DANGER",
  source: "local",
  sourceId: "",
  actionCategory: "agent.call",
  // delegate：子运行各自取执行许可，父批次不占额度；重放与投影都不在父层处理。
  policy: {
    version: TOOL_POLICY_VERSION,
    permission: { defaultDecision: "passthrough" },
    // timeoutMs 见 AGENT_SPAWN_TOOL_TIMEOUT_MS（= 两段子运行墙钟 + 编排余量）：取 team 模式
    // 的最坏时长。旧值 `loopConfig.toolTimeoutMs × 4`（120s）在模块加载时求值一次，既小于
    // team 的 ~180s 内部耗时、又不随配置变化 —— 声明比实际短会把仍在跑的团队判成超时
    // （2026-10-06 体检报告 R3）。
    execution: { effect: "external_side_effect", isolation: "delegate", replay: "never", timeoutMs: AGENT_SPAWN_TOOL_TIMEOUT_MS },
    context: { resultProjection: "reference", historyCompaction: "summarize" },
  },
}, async (params, ctx) => {
    const task = String(params.task ?? "")
    const mode = String(params.mode ?? "fork")

    if (!task.trim()) {
      return { success: false, content: "", error: "子代理任务不能为空" }
    }
    if (mode !== "fork" && mode !== "team") {
      return { success: false, content: "", error: `不支持的子代理模式: ${mode}（仅 fork/team）` }
    }
    if (mode === "fork" && params.angles !== undefined) {
      return { success: false, content: "", error: "angles 仅 team 模式可用" }
    }
    const parsedAngles: { angles?: string[]; error?: string } = mode === "team" ? parseTeamAngles(params.angles) : {}
    if (parsedAngles.error) {
      return { success: false, content: "", error: parsedAngles.error }
    }

    try {
      const { runForkAgent, runTeamAgent } = await import("@/services/agent/sub-agent")
      if (!ctx.sessionId || !Number.isSafeInteger(ctx.runGeneration) || !ctx.isCurrent) {
        return { success: false, content: "", error: "子代理缺少有效的父运行 owner" }
      }
      const owner = {
        kind: "conversation" as const, runId: `delegate-${crypto.randomUUID()}`,
        sessionId: ctx.sessionId, runGeneration: ctx.runGeneration!, isCurrent: ctx.isCurrent,
        ...(ctx.trustedUserEventId ? { trustedUserEventId: ctx.trustedUserEventId } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      }
      const result = mode === "team"
        ? await runTeamAgent({ task, ...(parsedAngles.angles ? { angles: parsedAngles.angles } : {}), owner })
        : await runForkAgent({ task, owner })
      // 未完成角度从成员结果取（`evidence.incomplete` 还混有 MCP 连接失败等非角度条目）。
      const failedAngles = result.members?.filter(member => !member.output.success).map(member => member.role) ?? []
      const content = mode === "team" && result.success && failedAngles.length > 0
        ? `【部分完成：未完成角度 ${failedAngles.join("、")}】\n\n${result.reply}`
        : result.reply
      return {
        success: result.success, content,
        ...(result.success ? {} : { error: result.error ?? "子代理执行失败" }),
        details: result,
      }
    } catch (e) {
      const msg = formatError(e)
      log.error("子代理异常:", msg)
      return { success: false, content: "", error: `子代理异常: ${msg}` }
    }
})

export function registerAgentSpawnTool(): void {
  register(agentSpawnTool)
  log.info("子代理工具已注册 (agent.spawn) — fork/team")
}
