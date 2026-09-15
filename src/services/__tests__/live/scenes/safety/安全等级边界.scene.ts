import type { SceneDef } from "../../types"
import { checkSafety, matchesAnyPattern, BASH_DANGEROUS_PATTERNS, BASH_NOWAY_PATTERNS, FILE_DANGEROUS_PATTERNS, trustToolInSession, resetSessionTrust, isToolTrusted } from "@/services/safety"
import type { ToolDef, SafetyLevel } from "@/services/tool"

const tool = (safetyLevel: SafetyLevel): ToolDef => ({ id: "test-safety", name: "test_safety", description: "test", parameters: { type: "object", properties: {} }, safetyLevel, source: "local", sourceId: "", mode: "pet", actionCategory: "_default", handler: async () => ({ success: true, content: "ok" }) })
const scene = (caseId: string, contractId: string, description: string, run: () => void, depth: "shallow" | "deep" = "shallow"): SceneDef => ({
  meta: { caseId, module: "safety", contractId, description, depth, suite: "safety", tags: ["safety", "boundary", "error"] },
  turns: [{ index: 1, description, userText: "检查安全策略。", checks: [{ type: "expectSafety", run: async () => run() }] }],
})

export const SAFE放行 = scene("safety-safe", "sf-01", "SAFE 放行", () => { if (!checkSafety(tool("SAFE"), {}, { mode: "pet", sessionTrusted: false }).allowed) throw new Error("SAFE 未放行") })
export const NORMAL检查 = scene("safety-normal", "sf-02", "NORMAL 轻量模式检查", () => { if (!checkSafety(tool("NORMAL"), {}, { mode: "pet", sessionTrusted: false }).allowed) throw new Error("NORMAL 未放行") })
export const DANGER拒绝 = scene("safety-danger", "sf-03", "DANGER 轻量模式拒绝", () => { if (checkSafety(tool("DANGER"), {}, { mode: "pet", sessionTrusted: false }).allowed) throw new Error("DANGER 被放行") }, "deep")
export const NOWAY拒绝 = scene("safety-noway", "sf-04", "NOWAY 即使信任也拒绝", () => { if (checkSafety(tool("NOWAY"), {}, { mode: "assistant", sessionTrusted: true }).allowed) throw new Error("NOWAY 被放行") })
export const 危险命令匹配 = scene("safety-danger-pattern", "sf-05", "危险命令匹配", () => { if (!matchesAnyPattern("sudo echo test", BASH_DANGEROUS_PATTERNS)) throw new Error("危险命令未命中") })
export const 硬禁止匹配 = scene("safety-noway-pattern", "sf-06", "硬禁止命令匹配", () => { if (!matchesAnyPattern("sudo rm -rf /", BASH_NOWAY_PATTERNS)) throw new Error("硬禁止未命中") })
export const 敏感路径匹配 = scene("safety-file-pattern", "sf-07", "敏感路径匹配", () => { if (!matchesAnyPattern("/home/user/.ssh/id_rsa", FILE_DANGEROUS_PATTERNS)) throw new Error("敏感路径未命中") })
export const 信任周期 = scene("safety-trust-lifecycle", "sf-08", "会话信任可清除且不越过动态禁止", () => {
  trustToolInSession("test_safety")
  if (!isToolTrusted("test_safety")) throw new Error("信任未记录")
  const dynamic = { ...tool("NORMAL"), resolveSafetyLevel: () => "NOWAY" as const }
  if (checkSafety(dynamic, {}, { mode: "assistant", sessionTrusted: true }).allowed) throw new Error("信任绕过动态禁止")
  resetSessionTrust()
  if (isToolTrusted("test_safety")) throw new Error("信任未清除")
}, "deep")
