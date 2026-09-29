// ==========================================
// 安全等级边界 —— 从 test/e2e/scenes/safety/安全等级边界.scene.ts 迁到 L3
// ==========================================
//
// 归属 L3 的理由（按 import 判定）：原场景 import `@/services/tool`
// （defineTool / getTool / TOOL_POLICY_VERSION），工具 barrel 会带出执行许可（IPC），
// 命中规则 6 的 L2 禁入清单。
//
// 断言直接调被测函数（matchesAnyPattern / resolveFilePathLevel / evaluateToolPermission），
// 与回合输出无关；分级类断言还要求分级真的接在注册过的生产工具上（pi-read / pi-bash）。
//
// 审视结论：7 个场景全部照搬。裁决表相关探针显式给回合冻结快照（字面值），
// 不跟本机 `ai.safety.mode` / 信任开关漂移；分级类断言用真实冻结值（它们与安全模式无关）。
// 配置前提：L3 没有 standard-setup 兜底，安全模式与信任开关在 beforeEach 钉死；
// 生产工具由 `registerDefaultTools()` 注册（原场景由宿主启动面完成同一件事）。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { setOverrides, toolsConfig } from "@/services/config"
import {
  BASH_DANGEROUS_PATTERNS,
  BASH_NOWAY_PATTERNS,
  FILE_DANGEROUS_PATTERNS,
  evaluateToolPermission,
  freezePermissionPolicy,
  matchesAnyPattern,
  resolveFilePathLevel,
} from "@/services/safety"
import type { PermissionPolicySnapshot } from "@/services/safety"
import { defineTool, getTool, registerDefaultTools, TOOL_POLICY_VERSION } from "@/services/tool"
import type { SafetyLevel, ToolContext, ToolDef } from "@/services/tool"

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

const context = (overrides: Partial<Parameters<typeof evaluateToolPermission>[2]> = {}) => ({
  sessionId: "safety-boundary-session", runGeneration: 1,
  toolCallId: "safety-boundary-call", policy: freezePermissionPolicy(), ...overrides,
})

/** 回合冻结快照的字面值。信任开关按关闭给：本文件断言的是裁决表，不是授权复用。 */
const snapshot = (safetyMode: PermissionPolicySnapshot["safetyMode"]): PermissionPolicySnapshot => ({
  safetyMode, sessionTrustEnabled: false,
})

let root = ""

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-safety-boundary-"))
  setTestDataRoot(root)
  // 判据要求的取值由本文件自己钉：L3 没有 standard-setup 兜底，也不能指望本机 CONFIG
  setOverrides({ "ai.safety.mode": "tell_me", "ai.safety.sessionTrustEnabled": false })
  await registerDefaultTools()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("安全等级边界", () => {
  it("SAFE 放行 [safety-safe]", async () => {
    const result = await evaluateToolPermission(tool("SAFE"), {}, context())
    expect(result.decision, "SAFE 未放行").toBe("allow")
    // 放行不是「确认后放行」：这条分支不生成待确认项。
    expect(result.request, "SAFE 放行却生成了确认请求").toBeUndefined()
  })

  it("NORMAL 一律放行（与安全模式、白名单无关） [safety-normal]", async () => {
    // 统一裁决表：SAFE 与 NORMAL 同为 allow，三种安全模式的结论必须一致。
    for (const safetyMode of ["just_do_it", "tell_me", "let_me_tk"] as const) {
      const result = await evaluateToolPermission(tool("NORMAL"), {}, context({
        policy: snapshot(safetyMode), toolCallId: `safety-normal-${safetyMode}`,
      }))
      expect(result.decision, `${safetyMode} 下 NORMAL 没有直接放行`).toBe("allow")
      expect(result.request, `${safetyMode} 下 NORMAL 生成了确认请求`).toBeUndefined()
    }
    // 白名单只决定 NORMAL / DANGER 的归属（免确认通道），不是拒绝依据。它已经不在裁决里，
    // 只挂在生产 pi-bash 的分级上：白名单命令 NORMAL、白名单外 DANGER、带 shell 组合符也 DANGER。
    const bash = getTool("pi-bash")
    expect(bash?.resolveSafetyLevel, "pi-bash 未注册 resolveSafetyLevel，分级没有接在生产工具上").toBeTypeOf("function")
    const resolveBashLevel = bash!.resolveSafetyLevel!
    const ctx: ToolContext = {}
    const whitelisted = toolsConfig.bashWhitelist[0]
    expect(whitelisted, "bash 白名单为空，白名单分级断言无法成立").toBeTruthy()
    expect(resolveBashLevel({ command: whitelisted! }, ctx), `白名单命令未评为 NORMAL: ${whitelisted}`).toBe("NORMAL")
    expect(resolveBashLevel({ command: "deskpet-not-whitelisted-command" }, ctx), "白名单外命令未评为 DANGER").toBe("DANGER")
    expect(resolveBashLevel({ command: `${whitelisted!} -la; true` }, ctx), "带 shell 组合符的白名单命令没有降为 DANGER").toBe("DANGER")
  })

  it("DANGER 由安全模式裁决（无 deny 归宿） [safety-danger]", async () => {
    // 分支一：默认（tell_me）→ ask，并生成带身份的确认请求。
    const ask = await evaluateToolPermission(tool("DANGER"), {}, context({
      policy: snapshot("tell_me"), toolCallId: "safety-danger-ask",
    }))
    expect(ask.decision, "默认安全模式下 DANGER 未走确认").toBe("ask")
    expect(ask.request, "ask 裁决没有生成确认请求").toBeDefined()
    const request = ask.request!
    expect(request.sessionId, "确认请求的会话身份不是本次裁决上下文").toBe("safety-boundary-session")
    expect(request.runGeneration, "确认请求的代际不是本次裁决上下文").toBe(1)
    expect(request.toolCallId, "确认请求的工具调用身份不是本次裁决上下文").toBe("safety-danger-ask")
    // 哈希是「确认后重新评估」的判据，必须随请求一起给出：参数哈希与策略哈希都非空。
    expect(request.inputHash, "确认请求缺少参数哈希").toBeTruthy()
    expect(request.policyHash, "确认请求缺少策略哈希").toBeTruthy()

    // 分支二：let_me_tk → ask。
    const conservative = await evaluateToolPermission(tool("DANGER"), {}, context({
      policy: snapshot("let_me_tk"), toolCallId: "safety-danger-conservative",
    }))
    expect(conservative.decision, "let_me_tk 下 DANGER 未走确认").toBe("ask")
    expect(conservative.request, "let_me_tk 的 ask 裁决没有生成确认请求").toBeDefined()

    // 分支三：just_do_it → allow（放行不生成确认请求）。
    const permissive = await evaluateToolPermission(tool("DANGER"), {}, context({
      policy: snapshot("just_do_it"), toolCallId: "safety-danger-permissive",
    }))
    expect(permissive.decision, "just_do_it 下 DANGER 未被放行").toBe("allow")
    expect(permissive.request, "just_do_it 放行却生成了确认请求").toBeUndefined()
  })

  it("NOWAY 直接拒绝（先于安全模式与工具侧策略） [safety-noway]", async () => {
    // 最宽松的组合也放不出去：安全模式 just_do_it + 工具侧声明 allow。
    const result = await evaluateToolPermission(tool("NOWAY", "allow"), {}, context({
      policy: snapshot("just_do_it"), toolCallId: "safety-noway-permissive",
    }))
    expect(result.decision, "NOWAY 被放行").toBe("deny")
    // 硬拒绝没有可确认的余地，不走确认通道。
    expect(result.request, "NOWAY 硬拒绝却生成了确认请求").toBeUndefined()
  })

  it("危险命令匹配 [safety-danger-pattern]", () => {
    expect(matchesAnyPattern("sudo echo test", BASH_DANGEROUS_PATTERNS), "危险命令未命中").toBe(true)
    // 递归删除的各种写法都要落进 DANGER：合并短选项、分开的短选项、长选项、多空格。
    for (const command of ["rm -rf /tmp/x", "rm -r -f /tmp/x", "rm  -rf  /tmp/x", "rm --recursive /tmp/x"]) {
      expect(matchesAnyPattern(command, BASH_DANGEROUS_PATTERNS), `危险命令未命中: ${command}`).toBe(true)
    }
    expect(matchesAnyPattern("rm file.txt", BASH_DANGEROUS_PATTERNS), "普通 rm 被误判为危险命令").toBe(false)
  })

  it("硬禁止命令匹配 [safety-noway-pattern]", () => {
    expect(matchesAnyPattern("sudo rm -rf /", BASH_NOWAY_PATTERNS), "硬禁止未命中").toBe(true)
    // 回归：旧正则尾部的 \b 落在 "/" 之后恒不成立，`rm -rf /` 只被判成 DANGER。
    expect(matchesAnyPattern("rm -rf /", BASH_NOWAY_PATTERNS), "rm -rf / 未命中硬禁止").toBe(true)
    expect(matchesAnyPattern("rm  -rf  /", BASH_NOWAY_PATTERNS), "多空格 rm -rf / 未命中硬禁止").toBe(true)
    // 误杀防护：非根目录不是硬禁止，只由 DANGER 兜住。
    expect(matchesAnyPattern("rm -rf /home/user", BASH_NOWAY_PATTERNS), "rm -rf /home/user 被误判为硬禁止").toBe(false)
  })

  it("敏感路径分级 [safety-file-pattern]", () => {
    expect(matchesAnyPattern("/home/user/.ssh/id_rsa", FILE_DANGEROUS_PATTERNS), "敏感路径未命中").toBe(true)

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
      expect(resolveFilePathLevel(path), `私钥路径未判为 NOWAY: ${path}`).toBe("NOWAY")
    }
    // .env 与系统目录：可由用户确认（不得升成 NOWAY，否则「用户确认后放行」的语义失效）
    for (const path of [
      "/home/user/.env", "/etc/passwd", "/etc/shadow", "/System/Library/CoreServices", "/Windows/System32/cmd.exe",
      ".env", "~/.env",
    ]) {
      expect(resolveFilePathLevel(path), `敏感路径未判为 DANGER: ${path}`).toBe("DANGER")
    }
    // 普通路径不额外提级，否则所有文件操作都会被弹窗；`.sshnotes` 不是 `.ssh` 目录组件
    for (const path of ["/home/user/notes.md", "/tmp/out.txt", "", "notes.md", "/Users/me/.sshnotes/readme.md"]) {
      expect(resolveFilePathLevel(path), `普通路径被误提级: ${path}`).toBe("SAFE")
    }
    // Windows 反斜杠先归一再匹配，否则同一份规则在两端表现不一致（fixture 里的 `C:\Users\me\.ssh\id_rsa`）
    expect(resolveFilePathLevel("C:\\Users\\me\\.ssh\\id_rsa"), "Windows 私钥路径未命中").toBe("NOWAY")
    // 参数缺失（模型漏填 path）不能顺带提级或抛错
    expect(resolveFilePathLevel(undefined), "缺失 path 参数应保持 SAFE").toBe("SAFE")

    // 分级必须真的挂在注册过的生产工具上，而不是只存在于 checker 里：
    // 直接取注册表里的工具声明调 resolveSafetyLevel（不执行命令、不读文件）。
    const readTool = getTool("pi-read")
    const bashTool = getTool("pi-bash")
    expect(readTool?.resolveSafetyLevel, "pi-read 未注册 resolveSafetyLevel，分级没有接在生产工具上").toBeTypeOf("function")
    expect(bashTool?.resolveSafetyLevel, "pi-bash 未注册 resolveSafetyLevel，分级没有接在生产工具上").toBeTypeOf("function")
    const resolveReadLevel = readTool!.resolveSafetyLevel!
    const resolveBashLevel = bashTool!.resolveSafetyLevel!
    const ctx: ToolContext = {}
    expect(resolveReadLevel({ path: "~/.ssh/id_rsa" }, ctx), "pi-read 没有把私钥路径提级为 NOWAY").toBe("NOWAY")
    expect(resolveReadLevel({ path: "/tmp/notes.md" }, ctx), "pi-read 对普通路径多提了一级").toBe("SAFE")
    // bash 的路径级检查管「对谁做」：命令模式本身不危险，参数指向凭据路径也要硬禁止
    expect(resolveBashLevel({ command: "cat ~/.ssh/id_rsa" }, ctx), "pi-bash 没有把凭据路径提级为 NOWAY").toBe("NOWAY")
    expect(resolveBashLevel({ command: "cat /tmp/notes.md" }, ctx), "pi-bash 把普通路径误判为硬禁止").not.toBe("NOWAY")
  })
})
