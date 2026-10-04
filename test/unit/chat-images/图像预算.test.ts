import { describe, expect, it } from "vitest"
import { estimateMessageTokens, projectMessageContent } from "@/services/context/budget"

describe("图像请求预算与审计", () => {
  it("用户图片有独立预算，编码长度不冒充token，审计区分真实图像 [chat-image-budget-content-hash]", () => {
    const small = { role: "user", content: [{ type: "image", mimeType: "image/png", data: "AAAA" }] }
    const large = { role: "user", content: [{ type: "image", mimeType: "image/png", data: "BBBB".repeat(10000) }] }
    expect(estimateMessageTokens(small)).toBeGreaterThanOrEqual(4096)
    expect(estimateMessageTokens(large)).toBe(estimateMessageTokens(small))
    const two = { role: "user", content: [...small.content, ...large.content] }
    expect(estimateMessageTokens(two) - estimateMessageTokens(small)).toBeGreaterThanOrEqual(4096)
    expect(projectMessageContent(small)).not.toBe(projectMessageContent(large))
    expect(estimateMessageTokens({ role: "user", content: "" })).toBeLessThan(32)
  })
})
