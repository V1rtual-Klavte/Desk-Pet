// ==========================================
// 助手模式工具：子代理 (NORMAL) — 桩
// Phase 3 实现完整 fork/team 逻辑
// ==========================================

import type { ToolDef } from "../types"
import { register } from "../registry"
import { createLogger } from "@/services/logger"

const log = createLogger("ToolAgent")

const agentSpawnTool: ToolDef = {
  id: "local-agent-spawn",
  name: "agent_spawn",
  description: "创建子代理执行独立任务。助手模式专用。",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "子代理的任务描述" },
      mode: { type: "string", description: "fork 或 team", enum: ["fork", "team"] },
    },
    required: ["task"],
  },
  safetyLevel: "NORMAL",
  source: "local",
  sourceId: "",
  mode: "assistant",
  timeoutMs: 60000,
  async handler(params) {
    // Phase 3 实现完整逻辑
    return {
      success: true,
      content: `[子代理已启动] 任务: ${params.task} — (功能开发中，将在 Phase 3 实现)`,
    }
  },
}

export function registerAgentSpawnTool(): void {
  register(agentSpawnTool)
  log.info("子代理工具已注册 (agent.spawn) — 桩")
}
