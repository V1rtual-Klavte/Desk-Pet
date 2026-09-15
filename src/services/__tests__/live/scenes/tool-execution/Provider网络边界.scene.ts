import type { SceneDef } from "../../types"
import { validateProviderUrl } from "@/services/agent/provider"

export const Provider网络边界: SceneDef = {
  meta: { caseId: "tool-provider-network-boundary", module: "tool-execution", contractId: "te-09", description: "Provider URL 协议边界", depth: "shallow", suite: "safety", tags: ["tool-execution", "boundary", "error"] },
  turns: [{ index: 1, description: "校验 Provider 网络地址", userText: "检查网络地址策略。", checks: [{ type: "expectReply", run: async () => {
    if (validateProviderUrl("https://localhost/v1").protocol !== "https:") throw new Error("HTTPS 未放行")
    let rejected = false
    try { validateProviderUrl("file:///tmp/provider") } catch { rejected = true }
    if (!rejected) throw new Error("非 HTTP 协议未拒绝")
  } }] }],
}

export default Provider网络边界
