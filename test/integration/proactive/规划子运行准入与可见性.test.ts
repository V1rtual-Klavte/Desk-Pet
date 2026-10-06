// ==========================================
// 规划子运行的两条接线契约（2026-10-06 真机根因取证后立）
// ==========================================
//
// 真机现象（用户报告）：聊天窗每隔几秒突然多出几条助手消息 + 一声「回复」音效，
// 下一瞬间又全部消失。
//
// 根因链（两处，各自独立成钉）：
//   ① `runPiSubAgent` 把 `providerAdmission` 传给 `createTurnSpec`，但后者的参数
//      类型里没有这个字段、也没有转发给 `createRequestViewHook` —— 对象字面量里的
//      spread 不参与多余属性检查，字段被**静默丢弃**。于是 `beforeProvider` 回调
//      从不执行 → 规划器的 claim 从不发生（`scanner.ts` 的 `planningClaimed` 恒 false，
//      走到静默 return）→ `proactive_evaluations` / `proactive_occurrences` 两层去重
//      表永远为空 → 同一个 rhythm 机会每个 tick 重生、**每个 tick 真发一次 provider 请求**。
//   ② 子运行的 sinks 与主回合共用（`runtime.ts` 的 `createTurnSinks`），把「带工具
//      调用的助手过程消息」「工具结果」与流式草稿推进**活跃会话的可见列表**；而子运行
//      槽是内存临时的、什么都不落盘 → 读模型下次重载时这些气泡整体消失（显示后消失）。
//
// 判据选择：① 用「拒绝型 beforeProvider + 空响应 fake provider」——若回调没被咨询，
// 请求必然发出，`payloads` 非空，两条断言同时红；② 直接断言可见列表为空。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { fakeText, fakeToolCall, installFakeProvider } from "../../host/fake-provider"
import { runPiSubAgent } from "@/services/engine/harness"
import { activeSessionId, chatHistory } from "@/services/session/store"

let root = ""

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deskpet-subagent-"))
  setTestDataRoot(root)
  activeSessionId.value = ""
  chatHistory.splice(0)
})

afterEach(() => {
  activeSessionId.value = ""
  chatHistory.splice(0)
  rmSync(root, { recursive: true, force: true })
})

describe("规划子运行", () => {
  it("beforeProvider 必须被咨询：拒绝时一个 provider 请求都不发 [subagent-provider-admission]", async () => {
    const provider = installFakeProvider([fakeText("不应到达")])
    const reservations: unknown[] = []

    const out = await runPiSubAgent({
      task: "只回一个 JSON",
      systemPrompt: "你是规划器",
      tools: [],
      maxOutputTokens: 256,
      scope: { sessionId: "subagent-admission", runGeneration: 1, isCurrent: () => true },
      beforeProvider: async reservation => {
        reservations.push(reservation)
        return false
      },
    })

    // 咨询恰好一次：多了是重复准入，少了就是接线断了（当前实现为 0）。
    expect(reservations).toHaveLength(1)
    // 被拒绝 ⇒ 请求一个都不该发出去（凭据与 token 都不该被花掉）。
    expect(provider.payloads).toHaveLength(0)
    expect(out.success).toBe(false)
  })

  it("子运行的中间态不进可见聊天列表 [subagent-chat-invisible]", async () => {
    const sessionId = "subagent-invisible"
    activeSessionId.value = sessionId
    chatHistory.splice(0)
    // 第一轮带工具调用（过程消息），第二轮收尾：两轮都不该出现在可见列表里。
    installFakeProvider([fakeToolCall("local-system-info", {}, "call-invisible"), fakeText("完成")])

    const out = await runPiSubAgent({
      task: "看一眼系统信息",
      systemPrompt: "你是子代理",
      tools: [],
      maxOutputTokens: 256,
      scope: { sessionId, runGeneration: 1, isCurrent: () => true },
    })

    expect(chatHistory).toHaveLength(0)
    expect(out.success).toBe(true)
  })
})
