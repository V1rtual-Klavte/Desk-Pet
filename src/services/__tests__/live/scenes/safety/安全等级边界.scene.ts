import type { SceneDef } from "../../types"
import { checkSafety, matchesAnyPattern, BASH_DANGEROUS_PATTERNS, BASH_NOWAY_PATTERNS, FILE_DANGEROUS_PATTERNS, resolveFilePathLevel, trustToolInSession, resetSessionTrust, isToolTrusted } from "@/services/safety"
import type { ToolDef, SafetyLevel } from "@/services/tool"
import { TOOL_POLICY_VERSION } from "@/services/tool"

/** 风险等级场景只关心 safetyLevel，策略用最小合法声明。 */
const tool = (safetyLevel: SafetyLevel): ToolDef => ({
  id: "test-safety", name: "test_safety", description: "test", parameters: { type: "object", properties: {} },
  safetyLevel, source: "local", sourceId: "", mode: "pet", actionCategory: "_default",
  policy: {
    version: TOOL_POLICY_VERSION,
    permission: { defaultDecision: "passthrough" },
    execution: { effect: "read", mode: "parallel", isolation: "shared_read", replay: "never" },
    context: { resultProjection: "reference", historyCompaction: "summarize" },
  },
  handler: async () => ({ success: true, content: "ok" }),
})
/**
 * 这里的 `run` 不接收任何上下文：断言直接调被测函数，与回合输出无关。
 *
 * 因此统一标 `entry: "unit"` —— 跑到真实模型上只会让这条场景的成败取决于
 * Provider 抖不抖，对断言本身没有任何增量。真正「门禁是否接在运行时上」
 * 由 sf-03 / sf-09 / sf-10 这些非 unit 场景负责。
 */
const scene = (caseId: string, contractId: string, description: string, run: () => void, depth: "shallow" | "deep" = "shallow"): SceneDef => ({
  meta: { caseId, module: "safety", contractId, description, depth, suite: "safety", entry: "unit", tags: ["safety", "boundary", "error"] },
  turns: [{ index: 1, description, userText: "检查安全策略。", checks: [{ type: "expectSafety", run: async () => run() }] }],
})

export const SAFE放行 = scene("safety-safe", "sf-01", "SAFE 放行", () => { if (!checkSafety(tool("SAFE"), {}, { mode: "pet" }).allowed) throw new Error("SAFE 未放行") })
export const NORMAL检查 = scene("safety-normal", "sf-02", "NORMAL 轻量模式检查", () => { if (!checkSafety(tool("NORMAL"), {}, { mode: "pet" }).allowed) throw new Error("NORMAL 未放行") })
export const DANGER拒绝 = scene("safety-danger", "sf-03", "DANGER 轻量模式拒绝", () => { if (checkSafety(tool("DANGER"), {}, { mode: "pet" }).allowed) throw new Error("DANGER 被放行") }, "deep")
export const NOWAY拒绝 = scene("safety-noway", "sf-04", "NOWAY 即使信任也拒绝", () => {
  // 先真的把工具标成已信任，再断言 NOWAY 不因信任而放行
  trustToolInSession("test_safety")
  try {
    if (checkSafety(tool("NOWAY"), {}, { mode: "assistant" }).allowed) throw new Error("NOWAY 被放行")
  } finally {
    resetSessionTrust()
  }
})
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

  // 下面三组是**共享 fixture 列表**：Rust 侧 `is_credential_path`（T1.08）用逐字相同的输入判同一件事 ——
  // 凭据路径不带前导斜杠、写成 `~`/`$HOME`/`${HOME}`、用反斜杠、夹 `./` 或 `..`，都不改变档位。
  // 改动这份列表必须两侧同时改。
  //
  // NOWAY: .ssh/id_rsa | ~/.ssh/id_rsa | $HOME/.ssh/id_rsa | ${HOME}/.ssh/id_rsa
  //        C:\Users\me\.ssh\id_rsa | x/../.ssh/id_rsa | ./cert.pem | ~/server.key | /etc/ssl/private/a.PEM
  // DANGER: .env | ~/.env | /etc/passwd | /etc/shadow | /System/Library/CoreServices | /Windows/System32/cmd.exe
  // SAFE:  notes.md | /tmp/out.txt | "" (缺失参数) | /Users/me/.sshnotes/readme.md (`.sshnotes` 不是 `.ssh` 组件)

  // 私钥与凭据：只读也不放行；相对形式与 home 简写必须与绝对形式同档
  for (const path of [
    "/home/user/.ssh/id_rsa", "/home/user/cert.pem", "/home/user/server.key",
    ".ssh/id_rsa", "~/.ssh/id_rsa", "$HOME/.ssh/id_rsa", "${HOME}/.ssh/id_rsa",
    "x/../.ssh/id_rsa", "./cert.pem", "~/server.key", "/etc/ssl/private/a.PEM",
  ]) {
    if (resolveFilePathLevel(path) !== "NOWAY") throw new Error(`私钥路径未判为 NOWAY: ${path}`)
  }
  // .env 与系统目录：可由用户确认（不得升成 NOWAY，否则助手模式「用户确认后放行」的语义失效）
  for (const path of [
    "/home/user/.env", "/etc/passwd", "/etc/shadow", "/System/Library/CoreServices", "/Windows/System32/cmd.exe",
    ".env", "~/.env",
  ]) {
    if (resolveFilePathLevel(path) !== "DANGER") throw new Error(`敏感路径未判为 DANGER: ${path}`)
  }
  // 普通路径不额外提级，否则所有文件操作都会被弹窗；`.sshnotes` 不是 `.ssh` 目录组件
  for (const path of ["/home/user/notes.md", "/tmp/out.txt", "", "notes.md", "/Users/me/.sshnotes/readme.md"]) {
    if (resolveFilePathLevel(path) !== "SAFE") throw new Error(`普通路径被误提级: ${path}`)
  }
  // Windows 反斜杠先归一再匹配，否则同一份规则在两端表现不一致（fixture 里的 `C:\Users\me\.ssh\id_rsa`）
  if (resolveFilePathLevel("C:\\Users\\me\\.ssh\\id_rsa") !== "NOWAY") throw new Error("Windows 私钥路径未命中")
  // 参数缺失（模型漏填 path）不能顺带提级或抛错
  if (resolveFilePathLevel(undefined) !== "SAFE") throw new Error("缺失 path 参数应保持 SAFE")
})
export const 信任周期 = scene("safety-trust-lifecycle", "sf-08", "会话信任按调用生效、可清除且不越过动态禁止", () => {
  trustToolInSession("test_safety")
  if (!isToolTrusted("test_safety")) throw new Error("信任未记录")
  const dynamic = { ...tool("NORMAL"), resolveSafetyLevel: () => "NOWAY" as const }
  if (checkSafety(dynamic, {}, { mode: "assistant" }).allowed) throw new Error("信任绕过动态禁止")
  resetSessionTrust()
  if (isToolTrusted("test_safety")) throw new Error("信任未清除")

  // 调用级信任只覆盖那一组参数：这是信任粒度收窄的核心断言
  trustToolInSession("test_safety", "signature-a")
  if (!isToolTrusted("test_safety", "signature-a")) throw new Error("调用级信任未记录")
  if (isToolTrusted("test_safety", "signature-b")) throw new Error("调用级信任越界到别的参数")
  if (isToolTrusted("test_safety")) throw new Error("调用级信任不应升级成整个工具")
  resetSessionTrust()
}, "deep")
