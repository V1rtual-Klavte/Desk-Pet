import type { SceneDef } from "../../types"
import { HookBus } from "@/services/engine/runtime"

const scene: SceneDef = {
  meta: { caseId: "safety-hook-errors", module: "safety", contractId: "sf-10", description: "Hook 超时与重入返回稳定错误码", depth: "deep", suite: "safety", tags: ["safety", "boundary", "error"] },
  turns: [{ index: 1, description: "验证 Hook 生命周期错误码", userText: "检查 Hook 门禁。", checks: [{ type: "expectSafety", run: async () => {
    const bus = new HookBus()
    bus.register({ id: "timeout", name: "timeout", mode: "blocking", deadlineMs: 1, handle: async () => new Promise(() => {}) })
    const timeout = await bus.emit({ hookId: "timeout", name: "timeout", sessionId: "s", turnId: "t", runId: "r", taint: "clean", payload: {} })
    if (timeout.decision !== "block" || timeout.errorCode !== "hook_timeout") throw new Error("Hook 超时错误码不稳定")
    bus.clear()
    bus.register({ id: "reentrant", name: "reentrant", mode: "blocking", handle: async event => bus.emit(event) })
    const reentrant = await bus.emit({ hookId: "reentrant", name: "reentrant", sessionId: "s", turnId: "t", runId: "r", taint: "clean", payload: {} })
    if (reentrant.decision !== "block" || reentrant.errorCode !== "hook_reentrancy") throw new Error("Hook 重入错误码不稳定")
  } }] }],
}

export default scene
