// ==========================================
// 助手模式工具：子代理 (NORMAL)
// Fork: 单个子代理独立执行任务
// Team: 多角色并行工作 + lead 汇总
// ==========================================

import type { ToolDef } from "../types"
import { register } from "../registry"
import { createLogger } from "@/services/logger"

const log = createLogger("ToolAgent")

const agentSpawnTool: ToolDef = {
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
  timeoutMs: 120000, // 子代理可能跑多轮工具调用
  personalityHint: {
    executing: "让我派个小助手去处理...",
    done: "小助手完成啦～",
  },
  async handler(params) {
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
      const msg = e instanceof Error ? e.message : String(e)
      log.error("子代理异常:", msg)
      return { success: false, content: "", error: `子代理异常: ${msg}` }
    }
  },
}

export function registerAgentSpawnTool(): void {
  register(agentSpawnTool)
  log.info("子代理工具已注册 (agent.spawn) — fork/team")
}
