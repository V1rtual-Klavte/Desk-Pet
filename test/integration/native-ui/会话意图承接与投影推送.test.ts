// ==========================================
// 会话意图承接与投影推送（A2）—— chat_* 五条方法 / 标签与历史回推时机
// ==========================================
//
// 归属 L3 的依据：本用例要**真 JSONL 落盘** —— `chat_new_session` / `chat_close_session` /
// `chat_delete_session` / `chat_restore_session` / `chat_request_session_history` 全部
// 经既有会话管理器操作真实会话文件（`createPiSession` / `deletePiSession` / 仓库扫描），
// 断言读的是磁盘事实（`listPiSessionMetadata` / `readPiSessionEntriesOnce`）；
// fake 只替换宿主桥的**记录面**（`apply_chat_projection` / `apply_titlebar_status` /
// `host_request_result` 记录下来，其余命令原样委托 Node 测试宿主），不用真实 Provider。
//
// 被测行为（A2；逐条对应 A1 的「A1 增补」五条意图）：
//   · `chat_new_session`：新建 + 欢迎语落盘 + 切换活跃；投影帧随标签列表回推；
//   · `chat_close_session`：移除标签但**保留会话文件**；关的是活跃会话时按旧壳收口切换；
//   · `chat_delete_session`：删文件（与关闭的语义差）+ 标签移除 + 活跃指针收口；
//   · `chat_restore_session`：按 id 查仓库恢复并切换；未知 id 如实失败、不改状态；
//   · `chat_request_session_history`：**回执先于投影帧**（宿主「读取中」的清除顺序）、
//     `sessionHistory` 随帧回推；推送失败不回改回执（如实留痕）；
//   · 触发时机：切换 / 改名（含首条消息自动命名路径共用的入口）/ 中断标记变化都重推；
//   · 启动首帧：装配后推一帧，未读取过历史时不携带 `sessionHistory`。
//
// **未运行**：本包交付时只做类型/编译检查（见交付报告）。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { NodeHostBridge } from "../../host/node-host-bridge"
import { setTestDataRoot } from "../../host/node-ipc"
import { initConfig } from "@/services/config"
import { setHostBridge, setUiEventPublisher, setUiReceiptSource } from "@/services/host"
import type { HostBridge } from "@/services/host"
import {
  HOST_REQUEST_EVENT,
  HOST_REQUEST_RESULT_METHOD,
  dispatchHostRequest,
  initNativeUiBridge,
  __resetSessionProjectionForTest,
  type SessionProjectionPayload,
} from "@/services/native-ui"
import { getCard, initCards } from "@/services/personality/loader"
import { FALLBACK_STAGES, stageSourceHash } from "@/services/personality/stages-cache"
import { updateStagesFile } from "@/services/personality/stages-file"
import { initPaths } from "@/services/paths"
import { switchPersonality } from "@/services/personality"
import {
  DESKPET_GREETING_ENTRY,
  chatHistory,
  createPiSession,
  getActiveSessionId,
  getSessions,
  initSessions,
  listPiSessionMetadata,
  openSession,
  readPiSessionEntriesOnce,
  setSessionInterrupted,
  switchToSession,
  updateSessionName,
} from "@/services/session"

/** 最小合法 CONFIG（general/ai/tools/appearance 四根；值只影响本文件要走的路径）。 */
const FIXTURE_CARD_ID = "chat-intents-probe"
const FIXTURE_GREETING = "【会话意图探针】你好"
/** 夹具卡：chat_new_session 的欢迎语只来自激活 Card（无卡不编台词是产品原则）。 */
function fixtureCardMarkdown(): string {
  return `---
id: ${FIXTURE_CARD_ID}
name: ${FIXTURE_CARD_ID}
description: 会话意图夹具卡
version: 1
---

# 角色设定
你是 ${FIXTURE_CARD_ID}。

# 语言风格
简短。

# 输出规则
不要输出多余的解释。
`
}

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

interface RecordedCall {
  method: string
  args: Record<string, unknown>
}

/**
 * 记录型宿主桥：只截获 A2 关心的三条命令（投影帧 / 顶栏文本 / 请求回执），
 * 其余原样委托 Node 测试宿主（真实会话文件 I/O 都在那边）；subscribe 用本地监听表
 * （Node 测试宿主对 subscribe 如实抛错，这里要模拟「有事件通道」的宿主）。
 */
function createRecordingBridge() {
  const inner = new NodeHostBridge()
  const calls: RecordedCall[] = []
  const listeners = new Map<string, (payload: unknown) => void>()
  const state = { failPush: false }
  const published: { event: string; payload: unknown }[] = []
  const bridge = {
    async request(method: string, args: Record<string, unknown>) {
      if (method === "apply_chat_projection") {
        calls.push({ method, args })
        if (state.failPush) {
          throw Object.assign(new Error("测试宿主拒绝投影推送"), { code: "OTHER" })
        }
        return null
      }
      if (method === "apply_titlebar_status" || method === HOST_REQUEST_RESULT_METHOD) {
        calls.push({ method, args })
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
  return { bridge, calls, listeners, state, published }
}

let root = ""
let recorder: ReturnType<typeof createRecordingBridge>

/** 已推送的投影帧（按发生顺序）。 */
function pushedFrames(): RecordedCall[] {
  return recorder.calls.filter((call) => call.method === "apply_chat_projection")
}

/** 最后一帧投影（没有收到时直接红，不拿空对象继续断言）。 */
function lastFrame(): SessionProjectionPayload {
  const frames = pushedFrames()
  expect(frames.length, "没有收到投影推送（apply_chat_projection）").toBeGreaterThan(0)
  return frames[frames.length - 1].args as unknown as SessionProjectionPayload
}

/** 会话文件是否还在磁盘上（L3 的事实来源）。 */
async function onDisk(sessionId: string): Promise<boolean> {
  return (await listPiSessionMetadata()).some((item) => item.id === sessionId)
}

/** 借仓库直接造一个已打开的标签（名字用「新会话」，改名路径才有可改的初值）。 */
async function seedTab(): Promise<string> {
  const summary = await createPiSession("新会话")
  openSession({ id: summary.id, name: summary.name || "新会话", createdAt: summary.createdAt, path: summary.path })
  return summary.id
}

/** 等 fire-and-forget 推送落地。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** 等前面测试的异步推送收尾后清空记录（避免串场影响「回执先于推送」这类顺序断言）。 */
async function settleThenReset(): Promise<void> {
  await flush()
  recorder.calls.length = 0
}

/** 轮询等待条件成立（超时用 expect 报红；断言驱动，不用手写 throw）。 */
async function waitFor(condition: () => boolean, label: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition()) {
    expect(Date.now(), `${label}（等待超时）`).toBeLessThan(deadline)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-native-ui-chat-"))
  setTestDataRoot(root)
  writeFileSync(join(root, "settings", "CONFIG.yaml"), CONFIG_YAML, "utf8")
  await initPaths()
  await initConfig()
  // 种一张探针卡并预写 stages（问候语换成探针串，零模型调用）：新建会话的欢迎语
  // 断言以「有激活卡且问候语可拾取」为前提，无卡时产品按设计不写欢迎语。
  const cardsDir = join(root, "personality", "cards")
  mkdirSync(cardsDir, { recursive: true })
  writeFileSync(join(cardsDir, `${FIXTURE_CARD_ID}.md`), fixtureCardMarkdown())
  await initCards()
  const fixtureCard = getCard(FIXTURE_CARD_ID)
  expect(fixtureCard, `夹具卡 ${FIXTURE_CARD_ID} 未从临时数据根加载`).toBeDefined()
  if (fixtureCard) {
    await updateStagesFile(fixtureCard.id, {
      stages: {
        cardId: fixtureCard.id,
        cardVersion: fixtureCard.version,
        sourceHash: await stageSourceHash(fixtureCard),
        generatedAt: Date.now(),
        isFallback: false,
        stages: { ...FALLBACK_STAGES, greetings: [FIXTURE_GREETING] },
      },
    })
  }
  // 激活夹具卡（注册表唯一入口）：pickActiveGreeting 读【激活卡】的 stages 缓存，
  // 未激活时 cache 为 null、问候语拾取为空 → 产品按设计不写欢迎语（0 条）。
  const switched = await switchPersonality(FIXTURE_CARD_ID)
  expect(switched.ok, `夹具卡激活失败：${JSON.stringify(switched)}`).toBe(true)
  const { pickActiveGreeting } = await import("@/services/personality")
  expect(pickActiveGreeting(), "激活卡的问候语拾取为空（cache 未装载？）").not.toBeNull()
  recorder = createRecordingBridge()
  setHostBridge(recorder.bridge)
  // UI 事件两口的装配与 connectHostBridge 等价：发布落记录面，回执订阅透传 recorder。
  setUiEventPublisher({
    publish: async (event, payload) => {
      recorder.published.push({ event, payload })
    },
  })
  setUiReceiptSource({
    subscribe: (event, listener) => recorder.bridge.subscribe(event as never, listener as never),
  })
  await initSessions()
  // 装配与产品引导一致：请求处理 + 会话/顶栏推送信号 + 启动首推。
  await initNativeUiBridge()
}, 30_000)

afterAll(() => {
  setHostBridge(null)
  if (root) rmSync(root, { recursive: true, force: true })
})

describe("会话意图承接（chat_* 宿主请求）", () => {
  it("装配后首推会话侧投影帧；未读取过历史时不携带 sessionHistory（宿主保持现值）[native-ui-session-projection-first-frame]", async () => {
    // 与测试顺序无关：强制回到「本进程还没读过历史」的初始态。
    __resetSessionProjectionForTest()
    await settleThenReset()

    await initNativeUiBridge()
    await flush()

    const frame = lastFrame()
    expect(frame.sessionId).toBe(getActiveSessionId())
    expect(frame.sessions.map((session) => session.id)).toEqual(getSessions().map((meta) => meta.id))
    expect(
      frame.sessions.every((session) => typeof session.name === "string" && typeof session.createdAt === "number"),
      "标签字段形状不完整（id/name/createdAt/interrupted）",
    ).toBe(true)
    expect("sessionHistory" in frame, "未读取过历史时不应携带 sessionHistory").toBe(false)
  })

  it("chat_new_session：新建进入标签并切换活跃，会话文件与欢迎语真落盘，投影帧跟随 [native-ui-chat-new-session]", async () => {
    await settleThenReset()
    const before = getSessions().map((meta) => meta.id)

    await dispatchHostRequest("chat_new_session", {})

    const created = getSessions().find((meta) => !before.includes(meta.id))
    expect(created, "新建会话没有进入标签列表").toBeDefined()
    expect(getActiveSessionId(), "新建后活跃指针没有切到新会话").toBe(created!.id)
    expect(await onDisk(created!.id), "新会话没有真落盘（仓库扫描不到）").toBe(true)

    // 欢迎语【落盘】依赖该会话的 harness lane（槽的 prepare 才建），新建会话此刻没有
    // run：产品把无槽期的宿主条目挂进审计队列、run 时补齐（不丢，见 harness-slot 的
    // orphanAudits）；「欢迎语经 JSONL 恢复」的端到端断言由领域引导序列用例覆盖。
    // 本条验证：欢迎语恰好一次（在磁盘或在该会话视图，双写/丢失都红）。
    const greetings = await readPiSessionEntriesOnce(created!.id, { customType: DESKPET_GREETING_ENTRY, order: "asc" })
    const inView = chatHistory.filter((message) => (message as { text?: string }).text?.includes(FIXTURE_GREETING)).length
    expect(greetings.length + inView, "欢迎语恰好一次（磁盘或视图；双写/丢失都算错）").toBe(1)

    await flush()
    const frame = lastFrame()
    expect(frame.sessionId).toBe(created!.id)
    expect(frame.sessions.map((session) => session.id)).toEqual(getSessions().map((meta) => meta.id))
  })

  it("chat_close_session：移除标签但保留会话文件；关非活跃会话不动活跃指针 [native-ui-chat-close-keeps-file]", async () => {
    await settleThenReset()
    const keeper = await seedTab()
    const target = await seedTab()
    await switchToSession(keeper)
    await settleThenReset()

    await dispatchHostRequest("chat_close_session", { sessionId: target })

    expect(getSessions().some((meta) => meta.id === target), "关闭后标签仍在").toBe(false)
    expect(await onDisk(target), "关闭标签不应删除会话文件（Close ≠ Delete）").toBe(true)
    expect(getActiveSessionId(), "关闭非活跃标签不应改变活跃指针").toBe(keeper)

    await flush()
    const frame = lastFrame()
    expect(frame.sessions.some((session) => session.id === target)).toBe(false)
    expect(frame.sessionId).toBe(keeper)
  })

  it("chat_close_session（活跃）：按旧壳收口切到首个剩余会话，文件保留 [native-ui-chat-close-active-switches]", async () => {
    await settleThenReset()
    await seedTab()
    const closing = await seedTab()
    await switchToSession(closing)
    await settleThenReset()

    await dispatchHostRequest("chat_close_session", { sessionId: closing })

    expect(getActiveSessionId(), "关闭活跃会话后活跃指针没有被收口").not.toBe(closing)
    expect(getActiveSessionId()).toBe(getSessions()[0].id)
    expect(await onDisk(closing), "关闭标签不得删除会话文件").toBe(true)

    await flush()
    const frame = lastFrame()
    expect(frame.sessionId).toBe(getSessions()[0].id)
  })

  it("chat_delete_session：删文件 + 标签移除 + 活跃指针收口（与关闭的语义差在同一条用例里对照）[native-ui-chat-delete-removes-file]", async () => {
    await settleThenReset()
    const target = await seedTab()
    await switchToSession(target)
    await settleThenReset()

    await dispatchHostRequest("chat_delete_session", { sessionId: target })

    expect(getSessions().some((meta) => meta.id === target), "删除后标签仍在").toBe(false)
    expect(await onDisk(target), "删除会话没有删除磁盘文件（Close ≠ Delete）").toBe(false)
    expect(getActiveSessionId(), "删除活跃会话后活跃指针没有被收口").toBe(getSessions()[0].id)

    await flush()
    const frame = lastFrame()
    expect(frame.sessions.some((session) => session.id === target)).toBe(false)
  })

  it("chat_restore_session：从历史按 id 查仓库恢复并切换到该会话 [native-ui-chat-restore]", async () => {
    await settleThenReset()
    const restored = await seedTab()
    await dispatchHostRequest("chat_close_session", { sessionId: restored })
    expect(getSessions().some((meta) => meta.id === restored), "前置：待恢复的会话应已不在标签里").toBe(false)
    await settleThenReset()

    await dispatchHostRequest("chat_restore_session", { sessionId: restored })

    expect(getSessions().some((meta) => meta.id === restored), "恢复没有把会话放回标签").toBe(true)
    expect(getActiveSessionId(), "恢复没有切换到该会话").toBe(restored)

    await flush()
    const frame = lastFrame()
    expect(frame.sessions.some((session) => session.id === restored)).toBe(true)
    expect(frame.sessionId).toBe(restored)
  })

  it("chat_restore_session（未知 id）：如实失败且不改动标签列表 [native-ui-chat-restore-unknown]", async () => {
    await settleThenReset()
    const before = getSessions().map((meta) => meta.id)

    await expect(
      dispatchHostRequest("chat_restore_session", { sessionId: "no-such-session" }),
    ).rejects.toMatchObject({ code: "PATH_NOT_FOUND" })

    expect(getSessions().map((meta) => meta.id)).toEqual(before)
    expect(pushedFrames().length, "失败的恢复不应产生投影推送").toBe(0)
  })

  it("chat_close_session / chat_delete_session / chat_restore_session 缺 sessionId 时以结构化 CONFIG 失败 [native-ui-chat-session-id-required]", async () => {
    for (const method of ["chat_close_session", "chat_delete_session", "chat_restore_session"]) {
      await expect(
        dispatchHostRequest(method, {}),
        `${method} 缺 sessionId 时应以结构化失败拒绝`,
      ).rejects.toMatchObject({ code: "CONFIG" })
    }
  })
})

describe("投影推送的时机与顺序", () => {
  it("切换 / 改名 / 中断标记变化都重推投影帧，载荷就是会话读模型的现值 [native-ui-projection-push-triggers]", async () => {
    await settleThenReset()
    const probe = await seedTab()

    await switchToSession(probe)
    await flush()
    expect(lastFrame().sessionId, "切换会话没有触发投影推送").toBe(probe)

    updateSessionName(probe, "改名探针")
    await flush()
    expect(lastFrame().sessions.find((session) => session.id === probe)?.name, "改名没有随投影回推").toBe("改名探针")

    setSessionInterrupted(probe, true)
    await flush()
    expect(
      lastFrame().sessions.find((session) => session.id === probe)?.interrupted,
      "中断标记没有随投影回推（标签角标的数据来源）",
    ).toBe(true)
  })

  it("chat_request_session_history：回执先于投影帧，sessionHistory 随帧回推 [native-ui-chat-session-history]", async () => {
    await settleThenReset()
    expect(recorder.listeners.has(HOST_REQUEST_EVENT), "前置：宿主请求订阅应已注册").toBe(true)

    recorder.listeners.get(HOST_REQUEST_EVENT)!({ requestId: 77, method: "chat_request_session_history", args: {} })
    await waitFor(
      () =>
        recorder.calls.some((call) => call.method === HOST_REQUEST_RESULT_METHOD && call.args.requestId === 77) &&
        pushedFrames().length > 0,
      "历史刷新的回执/投影帧没有到达",
    )

    const replyIndex = recorder.calls.findIndex(
      (call) => call.method === HOST_REQUEST_RESULT_METHOD && call.args.requestId === 77,
    )
    const pushIndex = recorder.calls.findIndex((call) => call.method === "apply_chat_projection")
    expect(replyIndex, "没有收到回执").toBeGreaterThanOrEqual(0)
    expect(pushIndex, "没有收到投影帧").toBeGreaterThanOrEqual(0)
    expect(pushIndex, "投影帧必须先于回执之后送达（宿主「读取中」的清除顺序）").toBeGreaterThan(replyIndex)

    const reply = recorder.calls[replyIndex]
    expect(reply.args.ok).toBe(true)
    const frame = recorder.calls[pushIndex].args as unknown as SessionProjectionPayload
    expect(frame.sessionHistory, "刷新结果没有随投影回推").toBeDefined()
    expect(frame.sessionHistory!.loaded).toBe(true)
    expect(frame.sessionHistory!.error).toBe(false)
    expect(frame.sessionHistory!.sessions.map((session) => session.id)).toContain(getActiveSessionId())
    expect(
      frame.sessionHistory!.sessions.every((session) => Number.isInteger(session.messageCount) && session.messageCount >= 0),
      "历史条目应带 messageCount（历史面板的展示字段）",
    ).toBe(true)
  })

  it("投影推送失败不改写回执：刷新已完成，失败只如实留痕 [native-ui-chat-history-push-failure]", async () => {
    await settleThenReset()
    recorder.state.failPush = true
    try {
      recorder.listeners.get(HOST_REQUEST_EVENT)!({ requestId: 88, method: "chat_request_session_history", args: {} })
      await waitFor(
        () => recorder.calls.some((call) => call.method === HOST_REQUEST_RESULT_METHOD && call.args.requestId === 88),
        "回执没有到达",
      )
      const reply = recorder.calls.find(
        (call) => call.method === HOST_REQUEST_RESULT_METHOD && call.args.requestId === 88,
      )!
      expect(reply.args.ok, "投影推送失败不应把已完成的刷新回执改成失败").toBe(true)
      // 回执之后仍有推送尝试（失败被留痕，不影响回执）。
      await waitFor(() => pushedFrames().length > 0, "推送尝试没有发生")
    } finally {
      recorder.state.failPush = false
    }
  })
})
