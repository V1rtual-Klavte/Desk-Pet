// ==========================================
// 提议计划的非确认归宿 —— 面板不可用 / 确认事件发射失败
// ==========================================
//
// 被测语义（用户 2026-10-06 裁决的第三条）：确认未成立时**如实返回**，不让模型以为执行了。
// 走真实工具入口（router 的 executeToolDefinition → propose_plan handler → 引擎相位），
// 只把 UI 端口换成假实现：
// ① 面板上报不可用（`ui_unavailable`，UI 按回执结算）→ 工具结果说明「计划面板不可用 / 未执行任何步骤」，
//    计划记录落 interrupted、步骤保持 pending，面板收起事件照发；
// ② 确认事件发射失败（`emit_failed`，UI 通道关闭）→ requestPlanConfirm 立即结算，
//    工具结果同样如实说明；不写假的执行结果、不落步骤产出。
//
// 归属 L3 的依据：import `@/services/tool`（router/handler）与 `@/services/engine`（计划相位），
// 且要真 JSONL 会话文件承载计划记录；Provider 不需要（两个归宿都停在确认，没有任何步骤执行）。

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
import { executeToolDefinition, getToolByName, registerDefaultTools } from "@/services/tool"
import { planCheckpointStore, planConfirmState, resolvePlanConfirm } from "@/services/engine"
import { setUiEventPublisher } from "@/services/host"
import type { ToolContext } from "@/services/tool"
import { getActiveSessionId } from "@/services/session/store"
import { initSessions } from "@/services/session"
import { initPaths } from "@/services/paths"

/** 工具名是线上契约（测试手写见证，不 import 实现常量）。 */
const TOOL = "propose_plan"

let root = ""
let sessionId = ""
let events: Array<{ event: string; payload: Record<string, unknown> }> = []

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-plan-tool-fail-"))
  setTestDataRoot(root)
  await initPaths()
  await registerDefaultTools()
  if (!getActiveSessionId()) await initSessions()
  sessionId = getActiveSessionId()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  events = []
})

function recordingPublisher(): void {
  setUiEventPublisher({ publish: async (event, payload) => { events.push({ event, payload: payload as Record<string, unknown> }) } })
}

/**
 * 「确认事件发不出去」的桩：只有 `deskpet-plan-start` 抛错，其余事件（面板收起）照记。
 *
 * 这里的 throw 是**夹具模拟 UI 通道关闭**，不是断言 —— 放在模块级夹具里，
 * 与 `recordingPublisher` 同一层（测试纪律 4 只禁「测试体里手写 throw 充当断言」）。
 */
function publisherFailingOnStart(): void {
  setUiEventPublisher({
    publish: async (event, payload) => {
      if (event === "deskpet-plan-start") throw new Error("UI 通道已关闭")
      events.push({ event, payload: payload as Record<string, unknown> })
    },
  })
}

function toolContext(toolCallId: string): ToolContext {
  return {
    sessionId,
    runGeneration: 0,
    toolCallId,
    isCurrent: () => true,
    signal: new AbortController().signal,
  }
}

const ONE_STEP = [{ description: "读一份文件", allowedTools: ["read"] }]

describe("提议计划的非确认归宿", () => {
  it("面板不可用：如实返回、计划落 interrupted、步骤保持 pending、面板收起 [plan-tool-panel-unavailable]", async () => {
    recordingPublisher()
    // 面板的等价物：观察到待确认计划后按「面板不可用」结算（与原生面板上报同一回执）。
    let panelAsked = false
    const stop = watch(() => planConfirmState.pending, pending => {
      if (!pending) return
      panelAsked = true
      resolvePlanConfirm(pending.planId, { confirmed: false, reason: "ui_unavailable" })
    }, { flush: "sync" })

    const tool = getToolByName(TOOL)
    expect(tool, "propose_plan 未注册").toBeDefined()
    const result = await executeToolDefinition(tool!, { summary: "一步计划", steps: ONE_STEP }, toolContext("panel-unavailable-1"))
    stop()

    expect(panelAsked, "工具没有走到计划确认面板（后续断言将失去意义）").toBe(true)
    expect(result.success, "面板不可用时工具结果不得报成功").toBe(false)
    expect(result.error, "面板不可用的说明没有与既有口径对齐").toContain("计划面板不可用")
    expect(result.error, "没有如实说明未执行").toContain("未执行任何步骤")
    expect(result.error, "误把未执行的计划报成执行结果").not.toContain("[计划执行结果]")
    expect(result.errorCode).toBe("cancelled")

    const record = planCheckpointStore.snapshot("plan-panel-unavailable-1")
    expect(record?.plan.state, "非确认归宿的计划没有落 interrupted").toBe("interrupted")
    expect(record?.steps.map(step => step.state), "一步都没跑，步骤应保持 pending").toEqual(["pending"])
    expect(events.filter(entry => entry.event === "deskpet-plan-progress"), "没有执行发生，不该有进度事件").toEqual([])
    expect(events.filter(entry => entry.event === "deskpet-plan-end").map(entry => entry.payload.reason), "面板没有收起").toEqual(["cancelled"])
  }, 30_000)

  it("确认事件发射失败：如实返回、计划落 interrupted、不写假结果 [plan-tool-emit-failed]", async () => {
    // UI 通道关闭：只有确认事件发不出去；其余事件（面板收起）照发。
    publisherFailingOnStart()

    const tool = getToolByName(TOOL)
    expect(tool, "propose_plan 未注册").toBeDefined()
    const result = await executeToolDefinition(tool!, { summary: "一步计划", steps: ONE_STEP }, toolContext("emit-failed-1"))

    expect(result.success, "确认送达失败时工具结果不得报成功").toBe(false)
    expect(result.error, "发射失败的说明没有与既有口径对齐").toContain("计划确认未能送达界面")
    expect(result.error, "没有如实说明未执行").toContain("未执行任何步骤")
    expect(result.errorCode).toBe("cancelled")

    const record = planCheckpointStore.snapshot("plan-emit-failed-1")
    expect(record?.plan.state, "发射失败的计划没有落 interrupted").toBe("interrupted")
    expect(record?.steps.map(step => step.state), "一步都没跑，步骤应保持 pending").toEqual(["pending"])
    expect(events.filter(entry => entry.event === "deskpet-plan-progress")).toEqual([])
    expect(events.filter(entry => entry.event === "deskpet-plan-end").map(entry => entry.payload.reason), "面板没有收起").toEqual(["cancelled"])
  }, 30_000)
})
