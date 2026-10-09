import { describe, expect, it } from "vitest"
import { observationEvidenceHash, observationWindowEvidenceId } from "@/services/observation/evidence"

describe("了解来源的稳定身份与输入版本", () => {
  it("同一 app 的窗口标题变化不产生新独立来源，变化内容仍产生新版本 hash [observation-window-artifact-stable]", async () => {
    const appId = "com.example.editor"
    const firstEvidenceId = await observationWindowEvidenceId(appId)
    const repeatedEvidenceId = await observationWindowEvidenceId(appId)
    const firstEvidenceHash = await observationEvidenceHash(JSON.stringify({ appId, title: "notes.txt — saved" }))
    const changedTitleHash = await observationEvidenceHash(JSON.stringify({ appId, title: "notes.txt — unsaved" }))

    expect(repeatedEvidenceId).toBe(firstEvidenceId)
    expect(changedTitleHash).not.toBe(firstEvidenceHash)
  })
})
