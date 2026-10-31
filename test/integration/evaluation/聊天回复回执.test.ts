import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest"
import { setTestDataRoot } from "../../host/node-ipc"
import { standardSetup } from "../../host/standard-setup"
import { fakeText, installFakeProvider } from "../../host/fake-provider"
import { initPaths } from "@/services/paths"
import { initChat, sendMessage } from "@/services/agent/runner"
import { resetPiRuntimeProviderForTest } from "@/services/engine/harness"
import { readPiSessionEntriesOnce } from "@/services/session"
import { getActiveSessionId } from "@/services/session/store"
import { resolveSimMessageReply } from "@/services/sim/chat-bridge"

let root = ""
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-reply-receipt-"))
  setTestDataRoot(root)
  await initPaths()
})
beforeEach(async () => { await standardSetup(); await initChat() })
afterEach(() => { resetPiRuntimeProviderForTest() })
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

it("直接回执按本次请求读取落盘正文，返回字符串不能替换它 [chat-receipt-committed-reply]", async () => {
  installFakeProvider([fakeText("真正提交的正文")])
  const requestId = "receipt-current-request"
  const result = await sendMessage("核对本次回复。", { requestId })
  expect(result.outcome).toBe("succeeded")
  const receipt = await resolveSimMessageReply(getActiveSessionId(), requestId, { ...result, reply: "未提交的瞬时字符串" })
  expect(receipt).toMatchObject({ reply: "真正提交的正文", outcome: "succeeded", replyBinding: "request-response" })
  const entries = await readPiSessionEntriesOnce(getActiveSessionId())
  expect(entries.find(entry => entry.id === receipt.assistantEntryId)).toMatchObject({ type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "真正提交的正文" }] } })
})

it("非空回执没有本次请求的提交证据时失败，不借用上一条回复 [chat-receipt-uncommitted-rejected]", async () => {
  installFakeProvider([fakeText("上一条请求的正文")])
  const previous = await sendMessage("上一条请求。", { requestId: "receipt-previous-request" })
  expect(previous.outcome).toBe("succeeded")
  const receipt = await resolveSimMessageReply(getActiveSessionId(), "receipt-missing-request", previous)
  expect(receipt).toEqual({ reply: "", outcome: "failed", replyBinding: "unavailable",
    failure: { kind: "unknown", message: "本次请求没有可核对的已提交助手正文" } })
})
