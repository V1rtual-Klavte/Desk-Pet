// ==========================================
// 本地工具：子代理 (DANGER)
// Fork: 单个子代理独立执行任务
// Team: 多角色并行工作 + lead 汇总
// ==========================================

import type { ToolDef } from "../types"
import { TOOL_POLICY_VERSION } from "../types"
import { defineTool } from "../policy"
import { register } from "../registry"
import { AGENT_SPAWN_TOOL_TIMEOUT_MS } from "@/services/agent/timeouts"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("ToolAgent")

const agentSpawnTool: ToolDef = defineTool({
  id: "local-agent-spawn",
  name: "agent_spawn",
  description:
    "创建子代理执行独立任务。mode=fork 时创建一个子代理独立工作；mode=team 时创建多个角色并行分析后汇总。子代理只拿到受限工具集（文件读取、系统信息与 Bash），不继承父代理的其余工具。",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "子代理的任务描述，越具体越好" },
      mode: {
        type: "string",
        description: "子代理模式：fork=单个代理独立工作, team=多角色并行分析后汇总",
        enum: ["fork", "team"],
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

    try {
      const { runForkAgent, runTeamAgent } = await import("@/services/agent/sub-agent")
      // 取消级联（与计划步骤同形）：父回合停止 / 切会话时子运行立刻停，不再跑满自己的
      // 90s 上限；没有会话归属（ctx 缺 sessionId）时不构造 scope，保持旧语义。
      const scope = ctx.sessionId
        ? {
            sessionId: ctx.sessionId,
            runGeneration: ctx.runGeneration ?? 0,
            isCurrent: ctx.isCurrent ?? (() => true),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }
        : undefined

      if (mode === "team") {
        const result = await runTeamAgent({ task, memberCount: 2, ...(scope ? { scope } : {}) })
        return { success: true, content: result }
      }

      // fork (默认)
      const result = await runForkAgent({ task, ...(scope ? { scope } : {}) })
      if (result.success) {
        return { success: true, content: result.reply }
      }
      return { success: false, content: "", error: result.error ?? "子代理执行失败" }
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
