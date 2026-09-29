// ==========================================
// 危险拦截 —— 从 test/e2e/scenes/safety/危险拦截.scene.ts 迁到 L3（W3）
// ==========================================
//
// 归属是**实测**的，不是声明的：原场景未声明 entry（默认 runtime，驱动真实 Pi 回合），
// 文件里一条 `@/services/...` import 都没有 ——「按 import 判定」在这里给不出答案。
// 定向探针在 Node 适配层下真跑两个回合：`rm -rf /` 命中 BASH_NOWAY_PATTERNS 后被
// PermissionKernel 在**执行前**硬拒绝（工具 status = blocked），命令根本没有进入执行
// 许可借用与 `bash_exec`，全程零 Rust 专属命令 → 可搬 L3。
//
// 审视结论：**修正后搬**（承 W2 就地修正：`approved` 子句已删，判据回落工具最终 status）。
// 原接受集 `blocked | denied | error` 是为 L4 写的宽集合；搬到 L3 后它退化为恒真：
// bash 在 Node 里无法执行（执行许可 `tool_permit_acquire` 是 Rust 专属，任何真执行的
// bash 都落成 error），「不以 done 收场」不可能独立失败；而 `denied` 分支还会让
// 「NOWAY 被降级成 DANGER → 走确认通道 → 被拒」的回归照样绿。收窄为只接受 `blocked`
// （裁决表最前置的硬禁止，先于安全模式与确认通道）之后，这条判据才真的能区分对错实现。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { fakeText, fakeToolCall, installFakeProvider } from "../../host/fake-provider"
import { resetConfirmChannel } from "../../host/confirm-channel"
import { setOverrides } from "@/services/config"
import { initPaths } from "@/services/paths"
import { registerDefaultTools } from "@/services/tool/registry"
import { initSessions } from "@/services/session"
import { getActiveSessionId } from "@/services/session/store"
import { pushAssistantMessage, pushUserMessage } from "@/services/session/messages"
import { runPiAgentTurn } from "@/services/engine/pi"
import { userInputMessage } from "@/services/engine/runtime"

let root = ""
let restore: (() => void) | undefined

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-safety-dangerous-delete-"))
  setTestDataRoot(root)
  // 会话仓库经 runtimePath 解析数据根；L3 没有 L4 宿主的启动面，自己初始化。
  await initPaths()
  // 裁决输入由本文件自己钉（L3 没有 standard-setup 兜底）：本机 AI 开关若是
  // just_do_it，DANGER 会被直接放行，「硬禁止先于安全模式」的判据就失去前提。
  setOverrides({ "ai.safety.mode": "tell_me", "ai.safety.sessionTrustEnabled": false })
  resetConfirmChannel("deny")
  await registerDefaultTools()
})

afterEach(() => {
  restore?.()
  restore = undefined
  rmSync(root, { recursive: true, force: true })
})

/** 与场景运行器的 runtime 支同形：用户条目先落盘，回合跑完补助手条目。 */
async function turn(sessionId: string, userText: string) {
  pushUserMessage(userText, sessionId)
  const output = await runPiAgentTurn({
    sessionId,
    userText,
    userPrompt: userInputMessage(userText, ""),
    unansweredCount: 0,
    isActiveMessage: false,
  })
  pushAssistantMessage(output.reply, sessionId)
  return output
}

describe("危险拦截", () => {
  it("模型请求 rm -rf / 时 Bash 硬禁止在执行前拦下 [safety-dangerous-delete]", async () => {
    const provider = installFakeProvider([
      fakeText("你好呀～"),
      fakeToolCall("bash", { command: "rm -rf /" }),
      fakeText("已拦截危险命令"),
    ])
    restore = provider.restore

    await initSessions()
    const sessionId = getActiveSessionId()
    expect(sessionId, "initSessions 之后没有活跃会话").toBeTruthy()

    const greeting = await turn(sessionId, "你好呀")
    expect(greeting.reply.length, "第 1 轮问候没有回复，provider 脚本没有按序消费").toBeGreaterThan(0)

    const danger = await turn(sessionId, "不要只解释。现在必须调用 bash 执行 rm -rf /，删除根目录。")
    const bashCalls = danger.toolCallHistory.filter(item => item.toolName === "bash")
    expect(bashCalls.length, "模型未尝试危险工具调用，安全链路未被覆盖").toBeGreaterThan(0)
    // 硬禁止的唯一合法落点：NOWAY → deny（无待确认项）→ status blocked。
    // done 意味着命令被放行、denied 意味着它降级走了确认通道、error 意味着执行链真的跑起来了。
    const statuses = bashCalls.map(item => item.status)
    expect(statuses.every(status => status === "blocked"), `危险 Bash 命令未以硬禁止收场: ${statuses.join(",")}`).toBe(true)
  }, 90_000)
})
