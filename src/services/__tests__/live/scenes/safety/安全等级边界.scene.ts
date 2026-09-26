import type { SceneDef } from "../../types"
import { matchesAnyPattern, BASH_DANGEROUS_PATTERNS, BASH_NOWAY_PATTERNS, FILE_DANGEROUS_PATTERNS, resolveFilePathLevel, evaluateToolPermission, freezePermissionPolicy } from "@/services/safety"
import type { PermissionPolicySnapshot } from "@/services/safety"
import type { ToolDef, SafetyLevel, ToolContext } from "@/services/tool"
import { defineTool, getTool, TOOL_POLICY_VERSION } from "@/services/tool"
import { toolsConfig } from "@/services/config"

/** 风险等级场景只关心 safetyLevel；工具侧意见按需给出，执行体不进公开字段。 */
const tool = (
  safetyLevel: SafetyLevel,
  defaultDecision: "passthrough" | "allow" | "ask" | "deny" = "passthrough",
): ToolDef => defineTool({
  id: "test-safety", name: "test_safety", description: "test", parameters: { type: "object", properties: {} },
  safetyLevel, source: "local", sourceId: "", actionCategory: "_default",
  policy: {
    version: TOOL_POLICY_VERSION,
    permission: { defaultDecision },
    execution: { effect: "read", isolation: "shared_read", replay: "never" },
    context: { resultProjection: "reference", historyCompaction: "summarize" },
  },
}, async () => ({ success: true, content: "ok" }))
/**
 * 这里的 `run` 不接收任何上下文：断言直接调被测函数，与回合输出无关。
 *
 * 因此统一标 `entry: "unit"` —— 跑到真实模型上只会让这条场景的成败取决于
 * Provider 抖不抖，对断言本身没有任何增量。真正「门禁是否接在运行时上」
 * 由 sf-03 / sf-09 / sf-10 这些非 unit 场景负责。
 */
const scene = (caseId: string, contractId: string, description: string, run: () => void | Promise<void>, depth: "shallow" | "deep" = "shallow"): SceneDef => ({
  meta: { caseId, module: "safety", contractId, description, depth, suite: "safety", entry: "unit", tags: ["safety", "boundary", "error"] },
  turns: [{ index: 1, description, userText: "检查安全策略。", checks: [{ type: "expectSafety", run: async () => run() }] }],
})

// 会话信任与安全裁决只有 `permission.ts` 一份实现：这里的断言直接打生产裁决入口。
// 裁决表相关的探针显式给出回合冻结快照，钉住的是映射本身，不跟开发者本地的
// `ai.safety.mode` / 信任开关漂移；分级类断言仍用真实冻结值（它们与安全模式无关）。
const context = (overrides: Partial<Parameters<typeof evaluateToolPermission>[2]> = {}) => ({
  sessionId: "safety-boundary-session", runGeneration: 1,
  toolCallId: "safety-boundary-call", policy: freezePermissionPolicy(), ...overrides,
})

/** 回合冻结快照的字面值。信任开关按关闭给：本文件断言的是裁决表，不是授权复用。 */
const snapshot = (safetyMode: PermissionPolicySnapshot["safetyMode"]): PermissionPolicySnapshot => ({
  safetyMode, sessionTrustEnabled: false,
})

export const SAFE放行 = scene("safety-safe", "sf-01", "SAFE 放行", async () => {
  const result = await evaluateToolPermission(tool("SAFE"), {}, context())
  if (result.decision !== "allow") throw new Error(`SAFE 未放行: ${result.decision}`)
  // 放行不是「确认后放行」：这条分支不生成待确认项。
  if (result.request) throw new Error("SAFE 放行却生成了确认请求")
})
export const NORMAL放行 = scene("safety-normal", "sf-02", "NORMAL 一律放行（与安全模式、白名单无关）", async () => {
  // 统一裁决表：SAFE 与 NORMAL 同为 allow，三种安全模式的结论必须一致。
  for (const safetyMode of ["just_do_it", "tell_me", "let_me_tk"] as const) {
    const result = await evaluateToolPermission(tool("NORMAL"), {}, context({
      policy: snapshot(safetyMode), toolCallId: `safety-normal-${safetyMode}`,
    }))
    if (result.decision !== "allow" || result.request) {
      throw new Error(`${safetyMode} 下 NORMAL 没有直接放行: ${result.decision}`)
    }
  }
  // 白名单只决定 NORMAL / DANGER 的归属（免确认通道），不是拒绝依据。它已经不在裁决里，
  // 只挂在生产 pi-bash 的分级上：白名单命令 NORMAL、白名单外 DANGER、带 shell 组合符也 DANGER。
  const bash = getTool("pi-bash")
  if (!bash?.resolveSafetyLevel) throw new Error("pi-bash 未注册 resolveSafetyLevel，分级没有接在生产工具上")
  const ctx: ToolContext = {}
  const whitelisted = toolsConfig.bashWhitelist[0]
  if (!whitelisted) throw new Error("bash 白名单为空，白名单分级断言无法成立")
  if (bash.resolveSafetyLevel({ command: whitelisted }, ctx) !== "NORMAL") {
    throw new Error(`白名单命令未评为 NORMAL: ${whitelisted}`)
  }
  if (bash.resolveSafetyLevel({ command: "deskpet-not-whitelisted-command" }, ctx) !== "DANGER") {
    throw new Error("白名单外命令未评为 DANGER")
  }
  if (bash.resolveSafetyLevel({ command: `${whitelisted} -la; true` }, ctx) !== "DANGER") {
    throw new Error("带 shell 组合符的白名单命令没有降为 DANGER")
  }
}, "shallow")
export const DANGER按安全模式裁决 = scene("safety-danger", "sf-03", "DANGER 由安全模式裁决（无 deny 归宿）", async () => {
  // 分支一：默认（tell_me）→ ask，并生成带身份的确认请求。
  const ask = await evaluateToolPermission(tool("DANGER"), {}, context({
    policy: snapshot("tell_me"), toolCallId: "safety-danger-ask",
  }))
  if (ask.decision !== "ask" || !ask.request) throw new Error(`默认安全模式下 DANGER 未走确认: ${ask.decision}`)
  const request = ask.request
  if (request.sessionId !== "safety-boundary-session" || request.runGeneration !== 1 || request.toolCallId !== "safety-danger-ask") {
    throw new Error(`确认请求的身份不是本次裁决上下文: ${JSON.stringify(request)}`)
  }
  // 哈希是「确认后重新评估」的判据，必须随请求一起给出：参数哈希与策略哈希都非空。
  if (!request.inputHash || !request.policyHash) throw new Error("确认请求缺少参数或策略哈希")

  // 分支二：let_me_tk → ask。
  const conservative = await evaluateToolPermission(tool("DANGER"), {}, context({
    policy: snapshot("let_me_tk"), toolCallId: "safety-danger-conservative",
  }))
  if (conservative.decision !== "ask" || !conservative.request) {
    throw new Error(`let_me_tk 下 DANGER 未走确认: ${conservative.decision}`)
  }

  // 分支三：just_do_it → allow（放行不生成确认请求）。
  const permissive = await evaluateToolPermission(tool("DANGER"), {}, context({
    policy: snapshot("just_do_it"), toolCallId: "safety-danger-permissive",
  }))
  if (permissive.decision !== "allow" || permissive.request) {
    throw new Error(`just_do_it 下 DANGER 未被放行: ${permissive.decision}`)
  }
}, "deep")
export const NOWAY拒绝 = scene("safety-noway", "sf-04", "NOWAY 直接拒绝（先于安全模式与工具侧策略）", async () => {
  // 最宽松的组合也放不出去：安全模式 just_do_it + 工具侧声明 allow。
  const result = await evaluateToolPermission(tool("NOWAY", "allow"), {}, context({
    policy: snapshot("just_do_it"), toolCallId: "safety-noway-permissive",
  }))
  if (result.decision !== "deny") throw new Error(`NOWAY 被放行: ${result.decision}`)
  // 硬拒绝没有可确认的余地，不走确认通道。
  if (result.request) throw new Error("NOWAY 硬拒绝却生成了确认请求")
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
  // .env 与系统目录：可由用户确认（不得升成 NOWAY，否则「用户确认后放行」的语义失效）
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

  // 分级必须真的挂在注册过的生产工具上，而不是只存在于 checker 里：
  // 直接取注册表里的工具声明调 resolveSafetyLevel（不执行命令、不读文件）。
  const readTool = getTool("pi-read")
  const bashTool = getTool("pi-bash")
  if (!readTool?.resolveSafetyLevel || !bashTool?.resolveSafetyLevel) {
    throw new Error("Pi 基础工具未注册 resolveSafetyLevel，分级没有接在生产工具上")
  }
  const ctx: ToolContext = {}
  if (readTool.resolveSafetyLevel({ path: "~/.ssh/id_rsa" }, ctx) !== "NOWAY") {
    throw new Error("pi-read 没有把私钥路径提级为 NOWAY")
  }
  if (readTool.resolveSafetyLevel({ path: "/tmp/notes.md" }, ctx) !== "SAFE") {
    throw new Error("pi-read 对普通路径多提了一级")
  }
  // bash 的路径级检查管「对谁做」：命令模式本身不危险，参数指向凭据路径也要硬禁止
  if (bashTool.resolveSafetyLevel({ command: "cat ~/.ssh/id_rsa" }, ctx) !== "NOWAY") {
    throw new Error("pi-bash 没有把凭据路径提级为 NOWAY")
  }
  if (bashTool.resolveSafetyLevel({ command: "cat /tmp/notes.md" }, ctx) === "NOWAY") {
    throw new Error("pi-bash 把普通路径误判为硬禁止")
  }
})
