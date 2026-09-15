import type { SceneDef } from "../../types"
import { checkSafety, matchesAnyPattern, BASH_DANGEROUS_PATTERNS, BASH_NOWAY_PATTERNS, FILE_DANGEROUS_PATTERNS, resolveFilePathLevel, trustToolInSession, resetSessionTrust, isToolTrusted } from "@/services/safety"
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
export const 危险命令匹配 = scene("safety-danger-pattern", "sf-05", "危险命令匹配", () => {
  if (!matchesAnyPattern("sudo echo test", BASH_DANGEROUS_PATTERNS)) throw new Error("危险命令未命中")
  // 递归删除的各种写法都要落进 DANGER：合并短选项、分开的短选项、长选项、多空格。
  for (const command of ["rm -rf /tmp/x", "rm -r -f /tmp/x", "rm  -rf  /tmp/x", "rm --recursive /tmp/x"]) {
    if (!matchesAnyPattern(command, BASH_DANGEROUS_PATTERNS)) throw new Error(`危险命令未命中: ${command}`)
  }
  if (matchesAnyPattern("rm file.txt", BASH_DANGEROUS_PATTERNS)) throw new Error("普通 rm 被误判为危险命令")
})
export const 硬禁止匹配 = scene("safety-noway-pattern", "sf-06", "硬禁止命令匹配", () => {
  if (!matchesAnyPattern("sudo rm -rf /", BASH_NOWAY_PATTERNS)) throw new Error("硬禁止未命中")
  // 回归：旧正则尾部的 \b 落在 "/" 之后恒不成立，`rm -rf /` 只被判成 DANGER。
  if (!matchesAnyPattern("rm -rf /", BASH_NOWAY_PATTERNS)) throw new Error("rm -rf / 未命中硬禁止")
  if (!matchesAnyPattern("rm  -rf  /", BASH_NOWAY_PATTERNS)) throw new Error("多空格 rm -rf / 未命中硬禁止")
  // 误杀防护：非根目录不是硬禁止，只由 DANGER 兜住。
  if (matchesAnyPattern("rm -rf /home/user", BASH_NOWAY_PATTERNS)) throw new Error("rm -rf /home/user 被误判为硬禁止")
})
export const 敏感路径匹配 = scene("safety-file-pattern", "sf-07", "敏感路径分级", () => {
  if (!matchesAnyPattern("/home/user/.ssh/id_rsa", FILE_DANGEROUS_PATTERNS)) throw new Error("敏感路径未命中")

  // 私钥与凭据：只读也不放行
  for (const path of ["/home/user/.ssh/id_rsa", "/home/user/cert.pem", "/home/user/server.key"]) {
    if (resolveFilePathLevel(path) !== "NOWAY") throw new Error(`私钥路径未判为 NOWAY: ${path}`)
  }
  // .env 与系统目录：可由用户确认
  for (const path of ["/home/user/.env", "/etc/passwd", "/etc/shadow", "/System/Library/CoreServices", "/Windows/System32/cmd.exe"]) {
    if (resolveFilePathLevel(path) !== "DANGER") throw new Error(`敏感路径未判为 DANGER: ${path}`)
  }
  // 普通路径不额外提级，否则所有文件操作都会被弹窗
  for (const path of ["/home/user/notes.md", "/tmp/out.txt", ""]) {
    if (resolveFilePathLevel(path) !== "SAFE") throw new Error(`普通路径被误提级: ${path}`)
  }
  // Windows 反斜杠先归一再匹配，否则同一份规则在两端表现不一致
  if (resolveFilePathLevel("C:\\Users\\me\\.ssh\\id_rsa") !== "NOWAY") throw new Error("Windows 私钥路径未命中")
  // 参数缺失（模型漏填 path）不能顺带提级或抛错
  if (resolveFilePathLevel(undefined) !== "SAFE") throw new Error("缺失 path 参数应保持 SAFE")
})
export const 信任周期 = scene("safety-trust-lifecycle", "sf-08", "会话信任可清除且不越过动态禁止", () => {
  trustToolInSession("test_safety")
  if (!isToolTrusted("test_safety")) throw new Error("信任未记录")
  const dynamic = { ...tool("NORMAL"), resolveSafetyLevel: () => "NOWAY" as const }
  if (checkSafety(dynamic, {}, { mode: "assistant", sessionTrusted: true }).allowed) throw new Error("信任绕过动态禁止")
  resetSessionTrust()
  if (isToolTrusted("test_safety")) throw new Error("信任未清除")
}, "deep")
