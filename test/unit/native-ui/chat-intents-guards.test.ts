// ==========================================
// 会话动作意图承接入参守卫与回执后推送分界（chat-intents.ts）—— L2
// ==========================================
//
// 归属 L2 的依据：本文件只覆盖**领域调用之前**就能判定的分支，以及记忆域以
// 模块替身承接后本层的编排行为 ——
//   · 会话级覆盖（思考强度 / 安全策略）写的是 `debug.ts` 的进程内槽（无落盘、无回合）；
//   · send / slash / stop / switch / remember 的入参守卫都在 `sendMessage` /
//     记忆库调用**之前**抛结构化 CONFIG（合法入参会进入真实领域链路，那属于 L3/L4）；
//   · remember 的可信来源链用 `vi.mock` 的记录型替身承接（只观测本层如何调用
//     解析器/提交口、失败是否原样透传）；真链路（真 JSONL 核验、Rust 记忆库门禁）
//     由 `test/integration/native-ui/记住这条与指令落盘.test.ts` 与 L4 覆盖；
//   · `runChatAfterReplyPush` 只读方法名集合 + 一次投影推送，用记录型假桥即可观测。
// 其余会话五条（new/close/delete/restore/history）的真 JSONL 行为已由
// `test/integration/native-ui/会话意图承接与投影推送.test.ts` 覆盖，本文件不重复。
//
// 被测行为：
//   · 档位写入 / 收回覆盖（null）都经 `debug.ts` 的既有出口读写；
//   · 非法档位、缺字段以 CONFIG 拒绝，且**不覆盖**已写入的值（不静默改档）；
//   · send / slash / remember 的形状守卫逐条以 CONFIG 拒绝（不静默丢弃、不放行空消息）；
//   · remember 解析失败原样透传（不重包、不伪加错误码、不进入提交）；成功来源按
//     evidence 组装 add 提交（actor=user_ui、可信身份随请求）并回传 revision；
//   · 回执后补推只对 `AFTER_REPLY_PUSH_METHODS` 动作；推送失败只留痕、不抛。

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { initConfig } from "@/services/config"
import {
  getSessionSafetyModeOverride,
  getSessionThinkingEffortOverride,
  resetSessionSafetyMode,
  resetSessionThinkingEffort,
} from "@/services/debug"
import { errorCode } from "@/services/error"
import { setHostBridge } from "@/services/host"
import type { HostBridge } from "@/services/host"
import { dispatchHostRequest, runChatAfterReplyPush } from "@/services/native-ui"

/**
 * 记忆域记录型替身：`chatRememberMessage` 只经动态 import 触达它。资格判定与
 * 证据组装都属于记忆域真实现，这里固定替身返回值，观测本层的行为边界。
 */
const memoryMock = vi.hoisted(() => ({
  MemoryService: { init: vi.fn(async () => {}) },
  resolveCurrentTrustedMemorySource: vi.fn(),
  memoryStatus: vi.fn(),
  applyMemoryChange: vi.fn(),
  publishMemoryRevision: vi.fn(),
}))

vi.mock("@/services/agent/memory", () => memoryMock)

/** 最小合法 CONFIG（四根齐全；值只影响本文件要走的路径）。 */
const CONFIG_YAML = `
general:
  popup:
    mode: cursor
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
  loop: { maxRetry: 3, maxToolCallsPerTurn: 5, maxParallelTools: 2 }
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

interface RecordedCall {
  method: string
  args: Record<string, unknown>
}

/**
 * 记录型假桥：`apply_chat_projection` 记录后按注入位拒绝（默认拒绝 —— 用来验证
 * 「推送失败只留痕」）；其余命令记录并成功应答。
 */
function createBridge() {
  const calls: RecordedCall[] = []
  const state = { failProjection: true }
  const bridge = {
    async request(method: string, args: Record<string, unknown>) {
      calls.push({ method, args })
      if (method === "read_runtime_config") return CONFIG_YAML
      if (method === "apply_chat_projection" && state.failProjection) {
        throw Object.assign(new Error("测试注入：宿主拒绝投影推送"), { code: "OTHER" })
      }
      return null
    },
    subscribe() {
      throw new Error("测试假桥没有事件通道")
    },
    async readBlob() {
      throw new Error("测试假桥不提供 blob")
    },
    async releaseBlob() {},
  } as unknown as HostBridge
  return { bridge, calls, state }
}

const recorder = createBridge()

function recorded(method: string): RecordedCall[] {
  return recorder.calls.filter(call => call.method === method)
}

beforeAll(async () => {
  setHostBridge(recorder.bridge)
  await initConfig()
})

afterEach(() => {
  resetSessionThinkingEffort()
  resetSessionSafetyMode()
  recorder.calls.length = 0
})

beforeEach(() => {
  memoryMock.MemoryService.init.mockClear()
  memoryMock.resolveCurrentTrustedMemorySource.mockReset()
  memoryMock.memoryStatus.mockReset()
  memoryMock.applyMemoryChange.mockReset()
  memoryMock.publishMemoryRevision.mockReset()
})

describe("会话级覆盖（思考强度 / 安全策略）", () => {
  it("档位写入与收回覆盖：null = 回到全局默认（覆盖读值是独立的原生槽）", async () => {
    await dispatchHostRequest("chat_set_thinking_effort", { effort: "high" })
    expect(getSessionThinkingEffortOverride()).toBe("high")
    await dispatchHostRequest("chat_set_thinking_effort", { effort: null })
    expect(getSessionThinkingEffortOverride(), "null 应收回覆盖而不是写一个 null 档位").toBeNull()

    await dispatchHostRequest("chat_set_safety_mode", { mode: "let_me_tk" })
    expect(getSessionSafetyModeOverride()).toBe("let_me_tk")
    await dispatchHostRequest("chat_set_safety_mode", { mode: null })
    expect(getSessionSafetyModeOverride()).toBeNull()
  })

  it("三档安全策略与四档思考强度逐个可写（不是只放行单个特例）", async () => {
    for (const effort of ["auto", "low", "medium", "high"] as const) {
      await dispatchHostRequest("chat_set_thinking_effort", { effort })
      expect(getSessionThinkingEffortOverride()).toBe(effort)
    }
    for (const mode of ["just_do_it", "tell_me", "let_me_tk"] as const) {
      await dispatchHostRequest("chat_set_safety_mode", { mode })
      expect(getSessionSafetyModeOverride()).toBe(mode)
    }
  })

  it("非法档位 / 缺字段以 CONFIG 拒绝，且不覆盖已写入的值（不静默改档）", async () => {
    await dispatchHostRequest("chat_set_thinking_effort", { effort: "low" })
    await expect(
      dispatchHostRequest("chat_set_thinking_effort", { effort: "extreme" }),
    ).rejects.toMatchObject({ code: "CONFIG" })
    await expect(
      dispatchHostRequest("chat_set_thinking_effort", {}),
      "缺 effort 不应被当成「收回覆盖」",
    ).rejects.toMatchObject({ code: "CONFIG" })
    expect(getSessionThinkingEffortOverride(), "被拒绝的写入不得改动现值").toBe("low")

    await dispatchHostRequest("chat_set_safety_mode", { mode: "tell_me" })
    await expect(
      dispatchHostRequest("chat_set_safety_mode", { mode: "allow_all" }),
    ).rejects.toMatchObject({ code: "CONFIG" })
    await expect(
      dispatchHostRequest("chat_set_safety_mode", {}),
    ).rejects.toMatchObject({ code: "CONFIG" })
    expect(getSessionSafetyModeOverride()).toBe("tell_me")
  })
})

describe("发送入口形状守卫（在领域调用之前拒绝）", () => {
  it("chat_send：text 非字符串 / 文本与图片同空 / imagePaths 含非字符串项都以 CONFIG 拒绝", async () => {
    await expect(dispatchHostRequest("chat_send", {}), "缺 text 必须拒绝").rejects.toMatchObject({
      code: "CONFIG",
    })
    await expect(
      dispatchHostRequest("chat_send", { text: "   ", imagePaths: [] }),
      "空白文本且无图片 = 空消息，不应放行",
    ).rejects.toMatchObject({ code: "CONFIG" })
    await expect(
      dispatchHostRequest("chat_send", { text: "hi", imagePaths: ["ok.png", 42] }),
    ).rejects.toMatchObject({ code: "CONFIG" })
  })

  it("chat_send：非法 delivery / 非法 sessionId 快照形状都以 CONFIG 拒绝", async () => {
    await expect(
      dispatchHostRequest("chat_send", { text: "hi", delivery: "later" }),
    ).rejects.toMatchObject({ code: "CONFIG" })
    await expect(
      dispatchHostRequest("chat_send", { text: "hi", sessionId: 42 }),
      "sessionId 形状无效是协议违规，不静默当无快照",
    ).rejects.toMatchObject({ code: "CONFIG" })
    await expect(
      dispatchHostRequest("chat_send", { text: "hi", sessionId: "   " }),
    ).rejects.toMatchObject({ code: "CONFIG" })
  })

  it("chat_slash_command：非「/」开头或非字符串一律拒绝（该入口只承载 slash）", async () => {
    await expect(
      dispatchHostRequest("chat_slash_command", { command: "普通消息" }),
    ).rejects.toMatchObject({ code: "CONFIG" })
    await expect(dispatchHostRequest("chat_slash_command", { command: "" })).rejects.toMatchObject({
      code: "CONFIG",
    })
    await expect(dispatchHostRequest("chat_slash_command", {})).rejects.toMatchObject({
      code: "CONFIG",
    })
  })

  it("chat_stop / chat_switch_session / chat_close_session / chat_delete_session / chat_restore_session 缺 sessionId 以 CONFIG 拒绝", async () => {
    for (const method of [
      "chat_stop",
      "chat_switch_session",
      "chat_close_session",
      "chat_delete_session",
      "chat_restore_session",
    ]) {
      await expect(
        dispatchHostRequest(method, {}),
        `${method} 缺 sessionId 应以结构化 CONFIG 拒绝`,
      ).rejects.toMatchObject({ code: "CONFIG" })
    }
  })

  it("chat_remember_message：缺 sessionId / eventId（含空白串）以 CONFIG 拒绝，不进入记忆链路", async () => {
    await expect(
      dispatchHostRequest("chat_remember_message", { eventId: "e1" }),
    ).rejects.toMatchObject({ code: "CONFIG" })
    await expect(
      dispatchHostRequest("chat_remember_message", { sessionId: "s1" }),
    ).rejects.toMatchObject({ code: "CONFIG" })
    await expect(
      dispatchHostRequest("chat_remember_message", { sessionId: "s1", eventId: "  " }),
    ).rejects.toMatchObject({ code: "CONFIG" })
  })
})

describe("记住这条：记忆域调用与失败透传（解析器以模块替身承接）", () => {
  it("解析器失败原样透传：不重包、不伪加错误码，也不进入提交", async () => {
    // 回归钉：非法来源的归宿是解析器的裸 Error（无 code）。本层曾用两个不可达的
    // `code:"MEMORY"` 分支宣称自己会结构化拒绝——若有人再包一层伪码，这里会红。
    const failure = new Error("当前可信用户来源缺失或不唯一")
    memoryMock.resolveCurrentTrustedMemorySource.mockRejectedValue(failure)

    let caught: unknown
    try {
      await dispatchHostRequest("chat_remember_message", { sessionId: "sess-1", eventId: "missing" })
    } catch (error) {
      caught = error
    }
    expect(caught, "解析失败必须如实抛出（不静默成功、不假报 revision）").toBe(failure)
    expect(errorCode(caught), "本层不伪加 MEMORY 码（回执码由宿主侧统一归一为 OTHER）").toBeNull()
    expect(memoryMock.applyMemoryChange, "解析失败不得进入提交").not.toHaveBeenCalled()
  })

  it("解析成功：按 evidence 组装 add 提交（actor=user_ui、可信身份随请求），revision 原样回执并同步", async () => {
    memoryMock.resolveCurrentTrustedMemorySource.mockResolvedValue({
      sourceId: "sess-1:entry-9",
      sessionId: "sess-1",
      entryId: "entry-9",
      eventId: "ev-9",
      seq: 3,
      contentHash: "hash-9",
      evidence: "我住在杭州",
      sourceLength: 5,
      eligibleForMemory: true,
      taint: "trusted_user",
      origin: "user",
      observedAt: 1_700_000_000_000,
    })
    memoryMock.memoryStatus.mockResolvedValue({ revision: 7, itemCount: 3 })
    memoryMock.applyMemoryChange.mockResolvedValue(8)
    memoryMock.publishMemoryRevision.mockResolvedValue(undefined)

    await expect(
      dispatchHostRequest("chat_remember_message", { sessionId: "sess-1", eventId: "ev-9" }),
    ).resolves.toEqual({ revision: 8 })

    expect(memoryMock.resolveCurrentTrustedMemorySource).toHaveBeenCalledWith("sess-1", "ev-9")
    expect(memoryMock.applyMemoryChange).toHaveBeenCalledTimes(1)
    const request = memoryMock.applyMemoryChange.mock.calls[0]![0] as Record<string, unknown>
    expect(request).toMatchObject({
      baseRevision: 7,
      action: "add",
      actor: "user_ui",
      trustedSessionId: "sess-1",
      trustedUserEventId: "ev-9",
      draft: {
        content: "我住在杭州",
        kind: "episode",
        scope: "user",
        sourceIds: ["sess-1:entry-9"],
        observedAt: 1_700_000_000_000,
      },
    })
    expect(String(request.operationId), "每次提交带独立幂等键").toMatch(/^remember-[0-9a-f-]{36}$/)
    expect(memoryMock.publishMemoryRevision, "提交成功后同步运行期记忆").toHaveBeenCalledWith(8)
  })
})

describe("回执后的投影重推分界（AFTER_REPLY_PUSH_METHODS）", () => {
  it("视情况方法（历史刷新 / 两个会话级覆盖）各补推一次投影帧", async () => {
    for (const method of [
      "chat_request_session_history",
      "chat_set_thinking_effort",
      "chat_set_safety_mode",
    ]) {
      recorder.calls.length = 0
      // 假桥拒绝投影推送（failProjection=true）：失败只留痕，不得向调用方抛。
      await expect(
        runChatAfterReplyPush(method),
        `${method} 的补推失败不应抛出（请求已受理、回执已发）`,
      ).resolves.toBeUndefined()

      const pushes = recorded("apply_chat_projection")
      expect(pushes, `${method} 应补推一次投影帧`).toHaveLength(1)
      // 推的是整帧投影（面板读模型随帧权威），不是空对象。
      const frame = pushes[0]!.args as { sessionId?: unknown; messages?: unknown }
      expect(typeof frame.sessionId, "投影帧应带当前会话 id（空会话为串）").toBe("string")
      expect(Array.isArray(frame.messages), "投影帧应带 messages 整表").toBe(true)
    }
  })

  it("非视情况方法 no-op：不产生任何桥调用（状态变化由领域写路径自行推送）", async () => {
    for (const method of ["chat_close_session", "chat_set_thinking_effort_x", "chat_send"]) {
      recorder.calls.length = 0
      await runChatAfterReplyPush(method)
      expect(recorder.calls, `${method} 不应触发任何推送`).toHaveLength(0)
    }
  })
})
