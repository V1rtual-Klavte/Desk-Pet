// ==========================================
// 向用户提问（ask_user）—— 走桌宠自己的选择面板，结果作为工具结果如实返回
// ==========================================
//
// 被测语义（用户 2026-10-06 裁决：需要用户做决定时给出问题与选项的弹窗，用户也能选
// 「其它」自由回答；权限类确认继续走权限面板，不合并）：
// ① 点选 → 工具结果如实返回所选项原文；提问事件带问题与选项（面板据此渲染）；
// ② 「其它」→ 工具结果说明「用户会在下一条消息里说明」，不替用户编内容；
// ③ 用户取消 → 如实返回、不假装用户选了任何一项；
// ④ 参数准入拒绝（问题为空 / 选项数越界 / 空选项 / 重复选项）点名到项，不开面板；
// ⑤ 提问事件发不出去（面板没送到）→ 按 emit_failed 如实结算，不悬挂；
// ⑥ **等待不占用回合墙钟**：用户停留超过回合时限（等待期停表）后回合仍能正常完成。
//
// 归属 L3 的依据：跑真实工具入口（router 的 executeToolDefinition）与真实回合
// （`_runtime-turn` 走 runPiAgentTurn），沿用测试宿主通道；只替换 Provider（fake 脚本）
// 与执行许可（Node 宿主没有 Rust 许可内核）。

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { watch } from "vue"

vi.mock("@/services/tool/execution-permit", () => ({
  acquireToolPermit: async () => ({ kind: "granted" }),
  releaseToolPermit: async () => {},
  setToolPermitLimit: async () => 4,
  permitSnapshot: async () => ({ limit: 4, inFlight: 0, queued: 0 }),
  flushPendingReleases: async () => {},
  retryBorrowerAttachIfPending: async () => {},
  failNextReleasesForTest: () => {},
}))

import { setTestDataRoot } from "../../host/node-ipc"
import { standardSetup } from "../../host/standard-setup"
import { fakeText, fakeToolCall, installFakeProvider } from "../../host/fake-provider"
import { runRuntimeTurn } from "./_runtime-turn"
import { setUiEventPublisher } from "@/services/host"
import { executeToolDefinition, getToolByName, registerDefaultTools } from "@/services/tool"
import type { ToolContext } from "@/services/tool"
import { choiceState, resolveChoice } from "@/services/engine/choice-confirmation"
import type { ChoiceResolution } from "@/services/engine/choice-confirmation"
import { flushConfig, getAllOverrides, setOverride, setOverrides } from "@/services/config"
import { getActiveSessionId } from "@/services/session/store"
import { initSessions } from "@/services/session"
import { initPaths } from "@/services/paths"

/** 工具名是线上契约（测试手写见证，不 import 实现常量）。 */
const TOOL = "ask_user"

let root = ""
let sessionId = ""
let events: Array<{ event: string; payload: Record<string, unknown> }> = []

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-ask-tool-"))
  setTestDataRoot(root)
  await initPaths()
  await registerDefaultTools()
  // 工具入口要求绑定会话（提问必须归属一个面板可见的会话）。
  if (!getActiveSessionId()) await initSessions()
  sessionId = getActiveSessionId()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  events = []
  setUiEventPublisher({
    publish: async (event, payload) => { events.push({ event, payload: payload as Record<string, unknown> }) },
  })
})

function toolContext(toolCallId: string): ToolContext {
  return {
    sessionId,
    runGeneration: 0,
    toolCallId,
    isCurrent: () => true,
    signal: new AbortController().signal,
  }
}

/**
 * 「提问事件发不出去」的桩：只有 `deskpet-choice-start` 抛错（模拟 UI 通道关闭）。
 *
 * 这里的 throw 是**夹具模拟**，不是断言 —— 放在模块级夹具里，与 recordingPublisher
 * 同一层（测试纪律 4 只禁「测试体里手写 throw 充当断言」）。
 */
function publisherFailingOnChoiceStart(): void {
  setUiEventPublisher({
    publish: async (event) => {
      if (event === "deskpet-choice-start") throw new Error("UI 通道已关闭")
    },
  })
}

/**
 * 面板的等价物：观察到待答提问后按给定策略结算（与原生面板上报同一回执）。
 * 返回停用函数；策略返回 null 表示这一条不答（留给用例自己处理）。
 */
function answerWith(policy: (question: string) => ChoiceResolution | null): () => void {
  return watch(
    () => choiceState.pending.map(view => view.requestId).join("|"),
    () => {
      for (const view of [...choiceState.pending]) {
        const resolution = policy(view.question)
        if (resolution) resolveChoice(view.requestId, resolution)
      }
    },
    { flush: "sync" },
  )
}

const ASK_PARAMS = { question: "喝什么？", options: ["咖啡", "茶"] }

describe("向用户提问工具", () => {
  it("点选：工具结果返回所选项原文，提问事件带问题与选项 [ask-tool-picked]", async () => {
    const stop = answerWith(() => ({ kind: "picked", index: 1 }))
    const tool = getToolByName(TOOL)
    expect(tool, "ask_user 未注册").toBeDefined()
    const result = await executeToolDefinition(tool!, ASK_PARAMS, toolContext("ask-picked-1"))
    stop()

    expect(result.success, `提问被拒：${result.error ?? "(无错误)"}`).toBe(true)
    expect(result.content, "工具结果没有返回所选项原文").toContain("茶")
    const start = events.find(entry => entry.event === "deskpet-choice-start")
    expect(start, "提问没有走到选择面板（后续断言将失去意义）").toBeDefined()
    expect(start?.payload).toEqual({
      sessionId,
      requestId: "choice-ask-picked-1",
      question: "喝什么？",
      options: ["咖啡", "茶"],
    })
  })

  it("「其它」：结果说明用户将在下一条消息里说明，不替用户编内容 [ask-tool-other]", async () => {
    const stop = answerWith(() => ({ kind: "other" }))
    const tool = getToolByName(TOOL)!
    const result = await executeToolDefinition(tool, ASK_PARAMS, toolContext("ask-other-1"))
    stop()

    expect(result.success, "「其它」是有效答复，不该报失败").toBe(true)
    expect(result.content, "没有说明「其它」的去向").toContain("其它")
    expect(result.content, "没有让模型等待用户的下一条消息").toContain("下一条消息")
    // 不替用户编内容：结果里不得出现任何选项原文。
    expect(result.content, "结果替用户编了选项内容").not.toContain("咖啡")
  })

  it("用户取消：如实返回，不假装用户选了任何一项 [ask-tool-cancel]", async () => {
    const stop = answerWith(() => ({ kind: "cancelled" }))
    const tool = getToolByName(TOOL)!
    const result = await executeToolDefinition(tool, ASK_PARAMS, toolContext("ask-cancel-1"))
    stop()

    expect(result.success, "用户取消不得报成功").toBe(false)
    expect(result.errorCode).toBe("cancelled")
    expect(result.error, "取消文案没有与通道口径对齐").toContain("用户取消了本次提问")
    expect(result.content, "取消结果里混进了选项原文").not.toContain("咖啡")
  })

  it("参数准入拒绝：问题为空 / 选项数越界 / 空选项 / 重复选项都点名到项且不开面板 [ask-tool-admission-rejects]", async () => {
    const tool = getToolByName(TOOL)!
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ question: "  ", options: ["甲", "乙"] }, "question 不能为空"],
      [{ question: "选一个", options: ["只有一个"] }, "2 到 6 个选项"],
      [{ question: "选一个", options: ["1", "2", "3", "4", "5", "6", "7"] }, "2 到 6 个选项"],
      [{ question: "选一个", options: ["甲", "   "] }, "第 2 个选项为空"],
      [{ question: "选一个", options: ["甲", "甲"] }, "选项重复"],
    ]
    for (const [index, [params, expected]] of cases.entries()) {
      const result = await executeToolDefinition(tool, params, toolContext(`ask-bad-${index}`))
      expect(result.success, `坏参数被放行：${JSON.stringify(params)}`).toBe(false)
      expect(result.error, `拒绝文案没有点名到项：${expected}`).toContain(expected)
    }
    // 关键否定：被拒绝的调用不得开面板（提问事件一条都没有）。
    expect(events.filter(entry => entry.event === "deskpet-choice-start"), "被拒绝的提问仍然开了面板").toEqual([])
    expect(choiceState.pending).toEqual([])
  })

  it("提问事件发不出去（面板没送到）：按 emit_failed 如实结算，不悬挂 [ask-tool-emit-failure]", async () => {
    // 夹具：只有 deskpet-choice-start 失败（模拟 UI 通道关闭）。
    publisherFailingOnChoiceStart()
    const tool = getToolByName(TOOL)!
    const result = await executeToolDefinition(tool, ASK_PARAMS, toolContext("ask-emit-fail-1"))

    expect(result.success, "送达失败时工具结果不得报成功").toBe(false)
    expect(result.errorCode).toBe("cancelled")
    expect(result.error, "送达失败的说明没有与通道口径对齐").toContain("未能送达界面")
    expect(choiceState.pending, "发射失败后仍有待答视图（请求已结算）").toEqual([])
  })
})

describe("等待不占用回合墙钟", () => {
  it("用户停留超过回合时限仍能完成（等待期停表，发布后按剩余预算续算） [ask-tool-wait-exempts-turn-budget]", async () => {
    await standardSetup("deny", "deny", "hold")
    const before = (getAllOverrides() as { ai?: { loop?: { turnTimeoutMs?: number } } }).ai?.loop?.turnTimeoutMs
    // 回合墙钟压到 1.5s（远小于用户停留时长），否则「沉默超时取消」的回归测不出来。
    setOverride("ai.loop.turnTimeoutMs", 1500)
    try {
      const provider = installFakeProvider([
        fakeToolCall(TOOL, { question: "选一个", options: ["甲", "乙"] }, "ask-exempt-1"),
        fakeText("好，按你的选择来"),
      ])
      // 面板等价物：先挂 2.2 秒（超过 1.5s 的回合墙钟）再作答 —— 模拟「用户想了一会儿」。
      const holdMs = 2200
      const stop = watch(
        () => choiceState.pending.map(view => view.requestId).join("|"),
        () => {
          for (const view of [...choiceState.pending]) {
            setTimeout(() => resolveChoice(view.requestId, { kind: "picked", index: 0 }), holdMs)
          }
        },
        { flush: "sync" },
      )
      const startedAt = Date.now()
      const output = await runRuntimeTurn("帮我决定")
      const elapsed = Date.now() - startedAt
      stop()

      // 前提：停留确实超过了墙钟（否则本用例没有测到豁免）。
      expect(elapsed, "停留时间没有超过回合墙钟，本用例失去意义").toBeGreaterThanOrEqual(holdMs)
      expect(output.failure, `回合被墙钟打断（等待期没有停表）：${output.failure?.message ?? "(无失败)"}`).toBeUndefined()
      expect(output.reply, "回合没有以模型正文收尾").toContain("好，按你的选择来")
      // 工具结果按所选返回（回合走到了下一次 Provider 请求）。
      const payload = provider.payloads[1] as { messages?: readonly unknown[] } | undefined
      const texts = (payload?.messages ?? []).map(raw => {
        const message = raw as { role?: string; toolName?: string; content?: unknown }
        if (message.role !== "toolResult" || message.toolName !== TOOL) return ""
        return Array.isArray(message.content)
          ? message.content.map(part => (part as { text?: string }).text ?? "").join("\n")
          : String(message.content ?? "")
      }).join("\n")
      expect(texts, "收尾请求里没有所选项的工具结果").toContain("甲")
    } finally {
      setOverrides({ "ai.loop.turnTimeoutMs": before })
      await flushConfig()
    }
  }, 60_000)
})
