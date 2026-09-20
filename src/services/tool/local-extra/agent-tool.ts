// ==========================================
// 助手模式工具：子代理 (NORMAL)
// Fork: 单个子代理独立执行任务
// Team: 多角色并行工作 + lead 汇总
// ==========================================

import type { ToolDef } from "../types"
import { TOOL_POLICY_VERSION } from "../types"
import { defineTool } from "../policy"
import { register } from "../registry"
import { loopConfig } from "@/services/config"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("ToolAgent")

const agentSpawnTool: ToolDef = defineTool({
  id: "local-agent-spawn",
  name: "agent_spawn",
  description:
    "创建子代理执行独立任务。mode=fork 时创建一个子代理独立工作；mode=team 时创建多个角色并行分析后汇总。子代理只能使用只读工具（文件读取/列表/搜索/系统信息/安全Bash/HTTP），不可写文件。",
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
  safetyLevel: "NORMAL",
  source: "local",
  sourceId: "",
  mode: "assistant",
  actionCategory: "agent.call",
  // delegate：子运行各自取执行许可，父批次不占额度；重放与投影都不在父层处理。
  policy: {
    version: TOOL_POLICY_VERSION,
    permission: { defaultDecision: "passthrough" },
    execution: { effect: "external_side_effect", mode: "sequential", isolation: "delegate", replay: "never", timeoutMs: loopConfig.toolTimeoutMs * 4 },
    context: { resultProjection: "reference", historyCompaction: "summarize" },
  },
}, async (params) => {
    const task = String(params.task ?? "")
    const mode = String(params.mode ?? "fork")

    if (!task.trim()) {
      return { success: false, content: "", error: "子代理任务不能为空" }
    }

    try {
      const { runForkAgent, runTeamAgent } = await import("@/services/agent/sub-agent")

      if (mode === "team") {
        const result = await runTeamAgent({ task, memberCount: 2 })
        return { success: true, content: result }
      }

      // fork (默认)
      const result = await runForkAgent({ task })
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
