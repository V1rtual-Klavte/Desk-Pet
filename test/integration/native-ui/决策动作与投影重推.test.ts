// ==========================================
// 决策类面板动作的投影重推 —— L3（真会话文件 + 记录型宿主桥）
// ==========================================
//
// 归属 L3 的依据：动作本身走既有领域入口，`chat_resume_plan` 的拒绝路径会**真写会话
// 文件**（系统消息落盘）；fake 只替换宿主桥的记录面（`apply_chat_projection` /
// `host_request_result` 记录下来，其余命令原样委托 Node 测试宿主；`subscribe` 用本地
// 监听表模拟「有事件通道」），不使用真实 Provider。
//
// 被测行为（decision-intents.ts 的面板读模型纪律）：
//   · 每个面板动作完成后都重推投影帧（队列 / 中断运行 / 待处置计划是「随帧权威、
//     缺省即清空」的整帧字段，不重推就会停在旧值）；
//   · 投影重推是 fire-and-forget：失败只留痕，不把已完成的动作改判成失败；
//   · 动作失败（未知副作用计划）在重推之前中止 —— 失败的处置不推「已处置」的帧。

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { NodeHostBridge } from "../../host/node-host-bridge"
import { setTestDataRoot } from "../../host/node-ipc"
import { initConfig } from "@/services/config"
import { setHostBridge } from "@/services/host"
import type { HostBridge } from "@/services/host"
import { dispatchHostRequest, type SessionProjectionPayload } from "@/services/native-ui"
import { initPaths } from "@/services/paths"
import {
  createPiSession,
  getActiveSessionId,
  initSessions,
  openSession,
  switchToSession,
} from "@/services/session"

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

interface RecordedCall {
  method: string
  args: Record<string, unknown>
}

/**
 * 记录型宿主桥：截获投影帧（可注入失败）与回执命令，其余委托 Node 测试宿主
 * （真会话文件 I/O 都在那边）；`subscribe` 用本地监听表 —— 本文件不经事件通道，
 * 只保证装配面不抛。
 */
function createRecordingBridge() {
  const inner = new NodeHostBridge()
  const calls: RecordedCall[] = []
  const listeners = new Map<string, (payload: unknown) => void>()
  const state = { failProjection: false }
  const bridge = {
    async request(method: string, args: Record<string, unknown>) {
      if (method === "apply_chat_projection") {
        calls.push({ method, args })
        if (state.failProjection) throw Object.assign(new Error("测试宿主拒绝投影推送"), { code: "OTHER" })
        return null
      }
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
  return { bridge, calls, listeners, state }
}

let root = ""
let recorder: ReturnType<typeof createRecordingBridge>

function frames(): RecordedCall[] {
  return recorder.calls.filter(call => call.method === "apply_chat_projection")
}

/** 等 fire-and-forget 的推送落地。 */
async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

/** 轮询等待投影帧数量超过水位（断言驱动，不用手写 throw）。 */
async function waitForFrames(min: number, label: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (frames().length < min) {
    expect(Date.now(), `${label}（等待超时）`).toBeLessThan(deadline)
    await flush()
  }
}

/** 等前一场的推送收尾后清空记录，避免串场影响「恰好一帧」这类断言。 */
async function settleThenReset(): Promise<void> {
  await flush()
  recorder.calls.length = 0
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-native-ui-decision-repush-"))
  setTestDataRoot(root)
  writeFileSync(join(root, "settings", "CONFIG.yaml"), CONFIG_YAML, "utf8")
  await initPaths()
  await initConfig()
  recorder = createRecordingBridge()
  setHostBridge(recorder.bridge)
  await initSessions()
  // 空数据根上 initSessions 不建会话：动作入口要求有效 sessionId。
  if (!getActiveSessionId()) {
    const summary = await createPiSession("重推探针")
    openSession({
      id: summary.id,
      name: summary.name || "重推探针",
      createdAt: summary.createdAt,
      path: summary.path,
    })
    await switchToSession(summary.id)
  }
}, 30_000)

afterAll(() => {
  setHostBridge(null)
  if (root) rmSync(root, { recursive: true, force: true })
})

describe("面板动作完成后的投影重推", () => {
  it("八条无确定拒绝的动作各补推一次整帧投影（面板读模型随帧权威）", async () => {
    const sessionId = getActiveSessionId()
    const actions: Array<[string, Record<string, unknown>]> = [
      ["chat_abort_running_plan", { sessionId }],
      ["chat_resume_plan", { sessionId, planId: "no-such-plan" }],
      ["chat_discard_plan", { sessionId, planId: "no-such-plan" }],
      ["chat_withdraw_queued", { sessionId, entryId: "no-such-entry" }],
      ["chat_resume_paused_inputs", { sessionId }],
      ["chat_discard_paused_inputs", { sessionId }],
      ["chat_discard_interrupted_run", { sessionId }],
      // continue 会打开会话槽，放最后：槽一旦打开，后续动作的读值面会变。
      ["chat_continue_interrupted_run", { sessionId }],
    ]
    for (const [method, args] of actions) {
      await settleThenReset()
      await dispatchHostRequest(method, args)
      await waitForFrames(1, `${method} 后的投影重推`)

      const frame = frames()[0]!.args as unknown as SessionProjectionPayload
      expect(frame.sessionId, `${method} 的帧应归属活跃会话`).toBe(sessionId)
      expect(Array.isArray(frame.messages), `${method} 的帧应带正文整表`).toBe(true)
    }
  })

  it("投影推送失败不回改动作结果：动作已完成，失败只留痕", async () => {
    const sessionId = getActiveSessionId()
    await settleThenReset()
    recorder.state.failProjection = true
    try {
      await expect(
        dispatchHostRequest("chat_discard_paused_inputs", { sessionId }),
        "推送失败不得让已完成的动作变成失败",
      ).resolves.toBeUndefined()
      await expect(
        dispatchHostRequest("chat_abort_running_plan", { sessionId }),
      ).resolves.toBeUndefined()
      // 推送确实被尝试过（失败被吞，不是根本没推）。
      expect(frames().length).toBeGreaterThanOrEqual(2)
    } finally {
      recorder.state.failProjection = false
    }
  })

  it("动作本身失败（未知副作用计划）在重推之前中止：不产生投影帧", async () => {
    await settleThenReset()
    await expect(
      dispatchHostRequest("chat_resolve_unknown_side_effect", {
        planId: "no-such-plan",
        stepId: "1",
        resolution: "retry",
      }),
    ).rejects.toThrowError(/plan record not found/)
    await flush()
    expect(frames(), "失败的处置不得推「已处置」的帧").toHaveLength(0)
  })
})
