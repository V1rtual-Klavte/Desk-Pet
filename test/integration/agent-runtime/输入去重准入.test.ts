// ==========================================
// 输入去重按真实准入记账：忙碌准入边界拒绝不消耗原文的 30s 去重窗口。
// L3：生产 sendMessage、真运行槽 / agent loop、fake Provider 与 JSONL 正文回读。
// ==========================================

import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { fakeText, installFakeProvider } from "../../host/fake-provider"
import { setTestDataRoot } from "../../host/node-ipc"
import { entryMessageText, sessionEntries } from "../../host/session-entries"
import { standardSetup } from "../../host/standard-setup"
import { initChat, sendMessage } from "@/services/agent/runner"
import { harnessSlots } from "@/services/engine/harness"
import { initPaths } from "@/services/paths"
import { getActiveSessionId } from "@/services/session/store"

const RETRY_TEXT = "准入去重：结构操作拒绝后应能原文重发。"
const REPLY_TEXT = "准入去重：重发已完成并写入正文。"

let dataRoot = ""

beforeAll(async () => {
  const testTempRoot = join(process.cwd(), "test/.tmp")
  mkdirSync(testTempRoot, { recursive: true })
  dataRoot = mkdtempSync(join(testTempRoot, "input-dedup-admission-"))
  setTestDataRoot(dataRoot)
  await initPaths()
})

afterAll(() => {
  rmSync(dataRoot, { recursive: true, force: true })
})

beforeEach(async () => {
  await standardSetup()
})

describe("输入去重准入", () => {
  it("忙碌准入边界拒绝后原文可重发，成功准入后相同文本才被过滤 [runtime-dedup-after-admission]", async () => {
    await initChat()
    const sessionId = getActiveSessionId()
    // 控制 busy guard + 无可投递运行槽的拒绝边界；此用例不声称启动了真实压缩任务。
    const busy = vi.spyOn(harnessSlots, "hasOpenOperation").mockResolvedValue(true)

    try {
      const rejected = await sendMessage(RETRY_TEXT)
      expect(rejected.outcome, "结构操作期间的输入必须如实拒绝").toBe("failed")
      expect(rejected.failure?.kind, "结构操作拒绝缺少 admission 分类").toBe("admission")
      expect((await sessionEntries(sessionId)).filter(entry =>
        entry.type === "message" && entry.message.role === "user" && entryMessageText(entry.message) === RETRY_TEXT,
      ), "被拒绝的原文进入了 JSONL 正文").toHaveLength(0)
    } finally {
      busy.mockRestore()
    }
    const provider = installFakeProvider([fakeText(REPLY_TEXT)])
    try {
      const admitted = await sendMessage(RETRY_TEXT)
      expect(admitted.outcome, `原文重发未获准入: ${admitted.failure?.message ?? admitted.reply}`).toBe("succeeded")
      expect(admitted.reply, "原文重发没有消费 Provider 回复").toContain(REPLY_TEXT)

      const duplicate = await sendMessage(RETRY_TEXT)
      expect(duplicate.outcome, "已准入原文的重复输入不应启动另一个失败回合").toBe("succeeded")
      expect(duplicate.reply, "已准入原文的重复输入意外产生了回复").toBe("")

      const persisted = (await sessionEntries(sessionId)).filter(entry =>
        entry.type === "message" && entry.message.role === "user" && entryMessageText(entry.message) === RETRY_TEXT,
      )
      expect(persisted, "JSONL 应只包含成功准入的一份原文").toHaveLength(1)
      expect(provider.state.callCount, "重复输入不应消费第二次 Provider 请求").toBe(1)
    } finally {
      provider.restore()
    }
  }, 30_000)
})
