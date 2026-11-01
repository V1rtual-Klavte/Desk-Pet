// L3: real turn preparation and provider payload, without executing a model or tools.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { fakeText, installFakeProvider } from "../../host/fake-provider"
import { setTestDataRoot } from "../../host/node-ipc"
import { standardSetup } from "../../host/standard-setup"
import { initPaths } from "@/services/paths"
import { initChat, sendMessage } from "@/services/agent/runner"
import { setOverrides } from "@/services/config"

let dataRoot = ""
beforeAll(async () => {
  mkdirSync(join(process.cwd(), "test/.tmp"), { recursive: true })
  dataRoot = mkdtempSync(join(process.cwd(), "test/.tmp/empty-tools-turn-"))
  setTestDataRoot(dataRoot)
  await initPaths()
})
afterAll(() => rmSync(dataRoot, { recursive: true, force: true }))
beforeEach(async () => { await standardSetup() })

describe("按回合冻结空工具面", () => {
  it("无工具回合明确拒绝 /plan，下一普通回合恢复工具 [runtime-empty-tools-turn]", async () => {
    await initChat()
    setOverrides({ "ai.plan.enabled": true })
    const provider = installFakeProvider([fakeText("普通回答")])
    try {
      const isolated = await sendMessage("/plan 先检索、再创建文件、最后执行命令", { toolMode: "none" })
      expect(isolated.outcome).toBe("failed")
      expect(isolated.toolCallsMade).toBe(0)
      expect(isolated.failure?.message).toContain("计划需要工具能力，无工具回合不能执行 /plan")
      expect(isolated.reply).toBe("计划需要工具能力，无工具回合不能执行 /plan")
      expect(provider.payloads, "拒绝 /plan 发生在任何模型请求之前").toHaveLength(0)
      setOverrides({ "ai.plan.enabled": false })
      const ordinary = await sendMessage("普通回合工具应该可用")
      expect(ordinary.outcome).toBe("succeeded")
      expect(provider.payloads).toHaveLength(1)
      expect(provider.payloads[0]?.tools?.some(tool => tool.name === "read_session_event")).toBe(true)
    } finally {
      provider.restore()
    }
  }, 30_000)
})
