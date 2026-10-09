import { describe, expect, it } from "vitest"
import { fauxAssistantMessage } from "@earendil-works/pi-ai"
import type { Entry } from "@earendil-works/pi-agent-core"
import { messagesFromEntries } from "@/services/session/read-model"

describe("原话检索复用可见投影", () => {
  it("跨text分块的写回协议与thinking不进入可见原话 [conversation-visible-text-only]", async () => {
    const assistant = fauxAssistantMessage([
      { type: "text", text: "我推荐这本书。<RUNTIME_DATA>\nsecret: hidden-card-value" },
      { type: "thinking", thinking: "hidden-reasoning" },
      { type: "text", text: "</RUNTIME_DATA>\n下次可以接着聊。" },
    ])
    const entry: Entry = { id: "answer", parentId: null, seq: 2, timestamp: 123, type: "message", message: assistant }
    const projected = await messagesFromEntries([entry], "original-session")
    expect(projected).toHaveLength(1)
    expect(projected[0]?.text).toBe("我推荐这本书。\n下次可以接着聊。")
    expect(projected[0]?.text).not.toContain("hidden-card-value")
    expect(projected[0]?.text).not.toContain("hidden-reasoning")
    expect(projected[0]?.id).toBe("answer")
    expect(projected[0]?.role).toBe("assistant")
  })
})
