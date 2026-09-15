import type { SceneDef } from "../../types"
import { executeTool } from "@/services/tool/router"
import { register, unregister } from "@/services/tool/registry"

const scene: SceneDef = {
  meta: { caseId: "tool-cancelled", module: "tool-execution", contractId: "te-10", description: "取消工具调用返回稳定错误码", depth: "shallow", suite: "safety", tags: ["tool-execution", "boundary", "error"] },
  turns: [{ index: 1, description: "验证取消不会进入工具 handler", userText: "检查工具取消。", checks: [{ type: "expectReply", run: async () => {
    let called = false
    const id = "live-cancelled-tool"
    register({ id, name: id, description: "test", parameters: { type: "object", properties: {} }, safetyLevel: "SAFE", source: "local", sourceId: "", mode: "pet", actionCategory: "_default", handler: async () => { called = true; return { success: true, content: "unexpected" } } })
    try {
      const controller = new AbortController()
      controller.abort()
      const result = await executeTool(id, {}, { mode: "pet", signal: controller.signal })
      if (called || result.success || result.errorCode !== "cancelled") throw new Error("取消工具未返回 cancelled")
    } finally {
      unregister(id)
    }
  } }] }],
}

export default scene
