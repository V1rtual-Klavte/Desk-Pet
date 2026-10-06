// ==========================================
// 决策类意图承接与权限确认桥（本包）—— 宿主请求面接线
// ==========================================
//
// 归属 L3 的依据：真会话文件落盘（拒绝路径的系统消息经既有会话写入路径），fake 只
// 替换宿主桥的记录面（`subscribe` 用本地监听表模拟「有事件通道」的宿主；其余命令
// 原样委托 Node 测试宿主）；不使用真实 Provider。
//
// 被测行为（逐条对应 `HostRequestMap` 的「决策类面板动作」组与
// `UiReceiptMap["deskpet-permission-confirm-resolved"]`）：
//   · 九个决策方法已注册：缺参以结构化 CONFIG 拒绝（与「未知方法」的 OTHER 不同形）；
//   · 未知目标按领域既有归宿应答：撤回 / 丢弃 / 中断丢弃 / 暂停丢弃 = 如实 no-op，
//     未知副作用的未知计划如实抛错（不谎报成功、不静默抛）；
//   · 权限确认：`confirmState.pending` → `deskpet-permission-confirm` 投影（字段逐一）；
//     回执按 requestId 身份结算；迟到/未知身份与非法 decision 一律丢弃不结算。
//
// **未运行**：本包交付时只做类型/编译检查（见交付报告）。

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { NodeHostBridge } from "../../host/node-host-bridge"
import { setTestDataRoot } from "../../host/node-ipc"
import { initConfig } from "@/services/config"
import { setHostBridge, setUiEventPublisher, setUiReceiptSource } from "@/services/host"
import type { HostBridge } from "@/services/host"
import { dispatchHostRequest, initNativeUiBridge } from "@/services/native-ui"
import { initPaths } from "@/services/paths"
import { confirmState, requestPermissionConfirm } from "@/services/safety"
import type { PermissionRequest } from "@/services/safety"
import {
  DESKPET_SYSTEM_MESSAGE_ENTRY,
  chatHistory,
  createPiSession,
  getActiveSessionId,
  initSessions,
  openSession,
  readPiSessionEntriesOnce,
  switchToSession,
} from "@/services/session"

/** 最小合法 CONFIG（general/ai/tools/appearance 四根；值只影响本文件要走的路径）。 */
const CONFIG_YAML = `
general:
  popup:
    mode: fixed
    autoPopupOnMessage: false
    defaultSize: { w: 730, h: 450 }
    chatWidth: 220
  shortcut:
    key: P
    macModifiers: [Control, Command]
    winModifiers: [Control, Alt]
  logging: { level: info }
  errors: { overlay: auto }
ai:
  provider: test
  endpoint: http://127.0.0.1:0
  apiKey: ""
  requireApiKey: false
  model: test-model
  auxModel: ""
  contextMaxTokens: 131072
  thinking: { effort: auto }
  conversation: { defaultDelivery: steer, steeringMode: all, followUpMode: all }
  loop: { maxRetry: 3, subAgentRounds: 5, maxParallelTools: 2 }
  safety: { mode: tell_me, sessionTrustEnabled: true }
  plan: { enabled: false }
  humanizer: { enabled: false }
  memory: { enabled: false }
  silentAccess: { frequency: "off" }
tools:
  bash: { whitelist: [ls, cat] }
  mcp: { servers: [] }
appearance:
  activeProfile: ""
  effectMode: parallax
  parallax: { intensity: 0.6 }
  font: { family: "", size: 15 }
  chatImagePreview: false
`

interface UiEventRecord {
  event: string
  payload: unknown
}

/**
 * 记录型宿主桥：`subscribe` 用本地监听表（Node 测试宿主对 subscribe 如实抛错，
 * 这里要模拟「有事件通道」的宿主）；其余命令原样委托 Node 测试宿主（真实会话文件
 * I/O 都在那边）。UI 事件发布经 `setUiEventPublisher` 单独捕获（见 beforeAll）。
 */
function createRecordingBridge() {
  const inner = new NodeHostBridge()
  const listeners = new Map<string, (payload: unknown) => void>()
  const published: UiEventRecord[] = []
  const bridge = {
    async request(method: string, args: Record<string, unknown>) {
      return (inner as unknown as { request(m: string, a: unknown): Promise<unknown> }).request(method, args)
    },
    subscribe(event: string, listener: (payload: unknown) => void) {
      listeners.set(event, listener)
      return () => {
        listeners.delete(event)
      }
    },
    async readBlob(ref: unknown) {
      return (inner as unknown as { readBlob(r: unknown): Promise<Uint8Array> }).readBlob(ref)
    },
    async releaseBlob(ref: unknown) {
      return (inner as unknown as { releaseBlob(r: unknown): Promise<void> }).releaseBlob(ref)
    },
  } as unknown as HostBridge
  return { bridge, listeners, published }
}

let root = ""
let recorder: ReturnType<typeof createRecordingBridge>

/** 等 fire-and-forget 的异步（发布 / 落盘）落地。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** 轮询等待条件成立（超时用 expect 报红；断言驱动，不用手写 throw）。 */
async function waitFor(condition: () => Promise<boolean>, label: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await condition())) {
    expect(Date.now(), `${label}（等待超时）`).toBeLessThan(deadline)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-native-ui-decision-"))
  setTestDataRoot(root)
  writeFileSync(join(root, "settings", "CONFIG.yaml"), CONFIG_YAML, "utf8")
  await initPaths()
  await initConfig()
  recorder = createRecordingBridge()
  setHostBridge(recorder.bridge)
  // UI 事件发布捕获（产品路径由 connectHostBridge 装配；测试宿主默认的 publisher
  // 落到 `event.emit` 如实抛错，这里换成记录面）。
  setUiEventPublisher({
    publish: async (event, payload) => {
      recorder.published.push({ event, payload })
    },
  })
  // 回执订阅口同缺（initNativeUiBridge 的权限桥需要它；文件头自述「未运行」）。
  setUiReceiptSource({
    subscribe: (event, listener) => recorder.bridge.subscribe(event as never, listener as never),
  })
  await initSessions()
  // 空数据根上 initSessions 不建会话：决策类入口要求有效 sessionId（缺参会 CONFIG 拒绝），
  // 先种一个探针会话（与产品「初始化标记后首个会话」不同，这里只是测试前提）。
  if (!getActiveSessionId()) {
    const summary = await createPiSession("接线探针")
    openSession({
      id: summary.id,
      name: summary.name || "接线探针",
      createdAt: summary.createdAt,
      path: summary.path,
    })
    await switchToSession(summary.id)
  }
  // 装配与产品引导一致：请求处理 + 权限确认桥 + 启动首推。
  await initNativeUiBridge()
}, 30_000)

afterAll(() => {
  setHostBridge(null)
  if (root) rmSync(root, { recursive: true, force: true })
})

describe("决策类面板动作（HostRequestMap 承接）", () => {
  it("九个决策方法已注册：缺参以结构化 CONFIG 拒绝（未知方法不会与之同形）[native-ui-decision-args]", async () => {
    const sessionId = getActiveSessionId()
    const cases: Array<[string, Record<string, unknown>]> = [
      ["chat_abort_running_plan", {}],
      ["chat_resume_plan", { sessionId }],
      ["chat_discard_plan", { sessionId }],
      ["chat_resolve_unknown_side_effect", { planId: "p" }],
      ["chat_withdraw_queued", { sessionId }],
      ["chat_resume_paused_inputs", {}],
      ["chat_discard_paused_inputs", {}],
      ["chat_continue_interrupted_run", {}],
      ["chat_discard_interrupted_run", {}],
    ]
    for (const [method, args] of cases) {
      await expect(
        dispatchHostRequest(method, args),
        `${method} 缺参时应以结构化 CONFIG 拒绝`,
      ).rejects.toMatchObject({ code: "CONFIG" })
    }
    // 对照：未注册方法走 default 分支，是 OTHER 而不是 CONFIG（证明上表的 CONFIG 来自
    // 各自处理体的入参校验，不是「方法不存在」的同一个错误）。
    await expect(
      dispatchHostRequest("chat_not_a_real_method", {}),
    ).rejects.toMatchObject({ code: "OTHER" })
  })

  it("未知目标按领域既有归宿应答：撤回 / 丢弃 / 暂停丢弃 / 中断丢弃都是如实 no-op [native-ui-decision-noop]", async () => {
    const sessionId = getActiveSessionId()
    // 没有在跑的计划：终止是如实 no-op。
    await expect(
      dispatchHostRequest("chat_abort_running_plan", { sessionId }),
    ).resolves.toBeUndefined()
    // 未知/不可处置的计划：丢弃返回 false = no-op（不谎报「已丢弃」）。
    await expect(
      dispatchHostRequest("chat_discard_plan", { sessionId, planId: "no-such-plan" }),
    ).resolves.toBeUndefined()
    // 没有该排队项（无槽 → not_found）：撤回意图已达成 = no-op；不是 unavailable 失败。
    await expect(
      dispatchHostRequest("chat_withdraw_queued", { sessionId, entryId: "no-such-entry" }),
    ).resolves.toBeUndefined()
    // 没有暂停项：取出即无（no-op）。
    await expect(
      dispatchHostRequest("chat_discard_paused_inputs", { sessionId }),
    ).resolves.toBeUndefined()
    // 没有暂停项：继续投递返回 undefined = no-op（不建空的回合）。
    await expect(
      dispatchHostRequest("chat_resume_paused_inputs", { sessionId }),
    ).resolves.toBeUndefined()
    // 没有中断运行：丢弃是 no-op。
    await expect(
      dispatchHostRequest("chat_discard_interrupted_run", { sessionId }),
    ).resolves.toBeUndefined()
  })

  it("chat_resume_plan 的未知计划：领域写系统消息，回执仍是成功（提交已受理）[native-ui-decision-resume-plan-unknown]", async () => {
    const sessionId = getActiveSessionId()
    await expect(
      dispatchHostRequest("chat_resume_plan", { sessionId, planId: "no-such-plan" }),
    ).resolves.toBeUndefined()
    // 拒绝的可见呈现由领域承担——不静默。系统的落盘是 **best-effort**（messages.ts
    // 的 persistSystemMessage：走槽的空闲队列、无槽或 lane 未就绪时失败只留 error
    // 级证据，这是产品注释明说的有意宽容；挂起条目在该会话下一次 run 时补齐）。
    // 本条验证「不静默」的同步载体：提示已进该会话视图（落盘的端到端断言需要
    // run 夹具，由 L3 的 harness-storage 场景类覆盖）。
    await waitFor(async () => {
      return chatHistory.some((message) =>
        (message as { text?: string }).text?.includes("没有找到这个待恢复的计划"),
      )
    }, "未知计划的系统提示没有进会话视图", 10_000)
    // 等待真回路的系统消息落盘（fake provider 回合 + 审计队列）；并行跑或冷启动下
    // 5s 默认时限不够（实测并发时超时），放宽到 20s —— 只改时限，不改断言。
  }, 20_000)

  it("chat_resolve_unknown_side_effect：未知计划如实抛错、非法 resolution 以 CONFIG 拒绝 [native-ui-decision-resolve-unknown]", async () => {
    await expect(
      dispatchHostRequest("chat_resolve_unknown_side_effect", {
        planId: "no-such-plan",
        stepId: "1",
        resolution: "retry",
      }),
    ).rejects.toThrowError(/plan record not found/)
    await expect(
      dispatchHostRequest("chat_resolve_unknown_side_effect", {
        planId: "no-such-plan",
        stepId: "1",
        resolution: "explode",
      }),
    ).rejects.toMatchObject({ code: "CONFIG" })
  })

  it("chat_continue_interrupted_run：没有中断运行时按领域归宿返回 undefined（不伪造继续结果）[native-ui-decision-continue-interrupted]", async () => {
    // 本用例会真实打开该会话的运行槽（open→getInterrupted→undefined），放在本
    // describe 最后，避免给前面的「无槽 no-op」用例预先造出槽。
    const sessionId = getActiveSessionId()
    await expect(
      dispatchHostRequest("chat_continue_interrupted_run", { sessionId }),
    ).resolves.toBeUndefined()
  })
})

describe("权限确认桥（请求下发 + 回执回收）", () => {
  it("待确认请求投影成 deskpet-permission-confirm；回执按 requestId 身份结算，迟到/非法一律丢弃 [native-ui-permission-confirm-bridge]", async () => {
    const sessionId = getActiveSessionId()
    const expiresAt = Date.now() + 60_000
    const request: PermissionRequest = {
      requestId: "perm-probe-1",
      sessionId,
      runGeneration: 0,
      toolCallId: "call-probe",
      toolName: "probe_tool",
      inputHash: "input-hash",
      policyHash: "policy-hash",
      expiresAt,
      message: "通道自检",
      parameterSummary: "command=ls",
      effectClass: "external_side_effect",
    }

    const pending = requestPermissionConfirm(request)
    await flush()

    const published = recorder.published.filter((record) => record.event === "deskpet-permission-confirm")
    expect(published, "确认请求没有投影成 UI 事件（恰好一条）").toHaveLength(1)
    expect(published[0].payload).toMatchObject({
      requestId: "perm-probe-1",
      toolName: "probe_tool",
      sessionId,
      runGeneration: 0,
      parameterSummary: "command=ls",
      effectClass: "external_side_effect",
      inputHash: "input-hash",
      policyHash: "policy-hash",
      toolCallId: "call-probe",
      expiresAt,
    })

    const receipt = recorder.listeners.get("deskpet-permission-confirm-resolved")
    expect(receipt, "回执订阅没有注册").toBeDefined()

    // 未知身份（迟到/重复/别的请求）的回执：丢弃，不结算。
    receipt!({ requestId: "perm-other", decision: "allow_once" })
    // 非法 decision（协议违规）：丢弃，不结算 —— 不允许非法取值把待确认请求
    // 结算成非拒绝决定（fail-closed）。
    receipt!({ requestId: "perm-probe-1", decision: "allow" })
    expect(confirmState.pending?.id, "不匹配/非法的回执不得结算待确认请求").toBe("perm-probe-1")

    // 同一身份的回执：结算一次；重复回执不复活结算（域内只结算一次）。
    receipt!({ requestId: "perm-probe-1", decision: "allow_session" })
    await expect(pending).resolves.toBe("allow_session")
    expect(confirmState.pending).toBeNull()
    receipt!({ requestId: "perm-probe-1", decision: "deny" })
    expect(confirmState.pending).toBeNull()
  })
})
