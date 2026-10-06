// ==========================================
// 后台完成通知接线 —— 订阅事件名、投递系统消息、非法载荷拒绝（L3）
// ==========================================
//
// 后台化批次（2026-10-06）：Rust 等待线程 emit `bash-background-finished`（只投 Node），
// Node 侧 `tool/background.ts` 订阅后把完成结果写进发起会话的聊天系统消息。本文件的
// 断言面是「接线」本身 —— 事件名与 Rust 线载荷同名（跨层对齐的唯一点）、合法载荷真的
// 落成一条系统消息、非法载荷与无会话归属时不落（只留痕）。
//
// 归属 L3（不是 L2）：`tool/background.ts` import `@/services/host` 与 `@/services/session`。
// 桥用 `setHostBridge` 注入记录型替身（与 MCP 桥传输用例同款），不真起宿主；
// 「投递」断言走真实链路（`pushSystemMessage` → 会话视图），不 mock 会话模块
// （背景工具模块在 setup 图里已被加载，vi.mock 无法追改它的绑定）。
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { setTestDataRoot } from "../../host/node-ipc"
import { setHostBridge } from "@/services/host"
import type { HostBridge } from "@/services/host"
import { activeSessionId, chatHistory, clearMessages } from "@/services/session/store"
import { disconnectBackgroundCommandNotifier, initBackgroundCommandNotifier } from "@/services/tool/background"

type Listener = (payload: unknown) => void

const subscriptions = new Map<string, Listener>()
const SESSION = "session-bg-notifier"

let root = ""

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "deskpet-bg-notifier-"))
  setTestDataRoot(root)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

afterEach(() => {
  disconnectBackgroundCommandNotifier()
  subscriptions.clear()
  setHostBridge(null)
  clearMessages()
  activeSessionId.value = ""
})

function installRecordingBridge(): void {
  const bridge = {
    subscribe(event: string, listener: Listener) {
      subscriptions.set(event, listener)
      return () => subscriptions.delete(event)
    },
    async request() { return null },
    async readBlob() { return new Uint8Array() },
    async releaseBlob() {},
  } as unknown as HostBridge
  setHostBridge(bridge)
}

const payload = {
  executionId: "exec-1",
  sessionId: SESSION,
  commandPreview: "npm run build",
  exitCode: 0,
  durationMs: 5_000,
  reason: "exited",
  silentMs: 200,
  producedBytes: 12,
  outputTail: "done",
  spillPath: null,
}

const systemTexts = () => chatHistory.filter(message => message.role === "system").map(message => message.text)

describe("后台完成通知接线", () => {
  it("订阅 Rust 同名事件，合法载荷落成发起会话的系统消息 [tool-bg-notifier-subscribe]", () => {
    installRecordingBridge()
    initBackgroundCommandNotifier()
    activeSessionId.value = SESSION

    // 事件名必须与 Rust `BridgeEventSink` 的 `"bash-background-finished"` 逐字一致：
    // 改名后本断言先红，而不是静默丢事件。
    const listener = subscriptions.get("bash-background-finished")
    expect(listener, "没有订阅 bash-background-finished 事件").toBeDefined()

    listener!(payload)
    const texts = systemTexts()
    expect(texts, "完成结果没有落成系统消息").toHaveLength(1)
    expect(texts[0], "正文不是完成通知（缺退出码/命令）").toContain("已完成")
    expect(texts[0]).toContain("npm run build")

    // 结构无效的载荷：拒绝投递（不猜字段、不糊一条假通知）。
    listener!({ ...payload, exitCode: "0" })
    expect(systemTexts(), "结构无效的载荷被投递了").toHaveLength(1)

    // 无会话归属：没有展示位，不投（只留痕）。
    listener!({ ...payload, sessionId: null })
    expect(systemTexts(), "无会话归属的载荷被投递了").toHaveLength(1)

    // 事件归属其它会话时：不落进当前视图（跨会话推送由落盘在切回时补齐，见 pushMessageFor）。
    activeSessionId.value = "another-session"
    listener!({ ...payload, sessionId: SESSION })
    expect(systemTexts(), "事件落进了错误的会话视图").toHaveLength(1)
  })
})
