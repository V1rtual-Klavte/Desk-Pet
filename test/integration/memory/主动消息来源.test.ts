// ==========================================
// 主动消息来源 —— 从 test/e2e/scenes/memory/P0快照.scene.ts 的 `主动消息来源` 迁到 L3
// ==========================================
//
// 被测：主动搭话落成 `deskpet.active_message` 自定义条目（active 来源、eligibleForMemory=false、
// taint=derived），模型看得到，但既不是用户可见正文、也不能成为用户事实。
//
// 归属 L3（不是 L2）的理由：断言读的是真实回合落盘的会话条目 —— 主动消息的投递路径
// （`sendActiveMessage`）驱动完整 agent loop，fake Provider 只替换 Provider。
//
// 审视结论：删掉 `fake provider 未被调用` 子句（断言宿主替场景跑了回合，不是产品行为）。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { fakeText, installFakeProvider } from "../../host/fake-provider"
import { sessionEntries, sessionMessages } from "../../host/session-entries"
import { runActiveTurn } from "./回合夹具"
import { initPaths } from "@/services/paths"

/** 主动消息正文：它出现在条目里，但绝不能出现在聊天视图里。 */
const ACTIVE_TEXT = "这是窗口上下文，不是用户输入。"

let root = ""

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-memory-active-origin-"))
  setTestDataRoot(root)
  await initPaths()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("主动消息来源", () => {
  it("主动搭话落成 active 条目，不写入用户事实 [memory-active-origin]", async () => {
    installFakeProvider([fakeText("主动消息已处理")])
    await runActiveTurn(ACTIVE_TEXT)

    // 主动消息以 deskpet.active_message 自定义消息投递：模型看得到，但不是用户事实条目。
    const entries = await sessionEntries()
    const active = entries.find(entry => entry.type === "message" && entry.message.role === "custom"
      && entry.message.customType === "deskpet.active_message")
    expect(active, "主动消息没有落成 deskpet.active_message 条目").toBeDefined()
    const details = (active as { message: { details?: Record<string, unknown> } }).message.details ?? {}
    expect(
      { querySource: details.querySource, eligibleForMemory: details.eligibleForMemory, taint: details.taint },
      `主动消息缺少 active 来源元数据: ${JSON.stringify(details)}`,
    ).toEqual({ querySource: "active_monitor", eligibleForMemory: false, taint: "derived" })

    // 聊天视图与用户事实都不包含主动消息正文（messagesFromEntries 不投影 custom）。
    const messages = await sessionMessages()
    expect(
      messages.filter(message => message.text.includes("窗口上下文")).map(message => message.text),
      "主动消息被写成用户可见正文",
    ).toEqual([])
  })
})
