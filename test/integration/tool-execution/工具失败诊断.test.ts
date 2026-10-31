import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest"

vi.mock("@/services/tool/execution-permit", () => ({
  acquireToolPermit: async () => ({ kind: "granted" }), releaseToolPermit: async () => {},
  setToolPermitLimit: async () => 4, permitSnapshot: async () => ({ limit: 4, inFlight: 0, queued: 0 }),
  flushPendingReleases: async () => {}, retryBorrowerAttachIfPending: async () => {}, failNextReleasesForTest: () => {},
}))

import { setTestDataRoot } from "../../host/node-ipc"
import { standardSetup } from "../../host/standard-setup"
import { fakeText, fakeToolCall, installFakeProvider } from "../../host/fake-provider"
import { runRuntimeTurn } from "../agent-runtime/_runtime-turn"
import { defineTool, register, unregister, TOOL_POLICY_VERSION } from "@/services/tool"
import { resetPiRuntimeProviderForTest } from "@/services/engine/harness"
import { initPaths } from "@/services/paths"
import { readPiSessionEntriesOnce } from "@/services/session"
import { getActiveSessionId } from "@/services/session/store"

const TOOL_ID = "diagnostic-probe"
const TOOL_NAME = "diagnostic_probe"
const DIAGNOSTIC = '{"status":"needs_clarification","missing":["execution"],"errors":[],"limitations":[]}'
const probe = defineTool({
  id: TOOL_ID, name: TOOL_NAME, description: "诊断透传探针",
  parameters: { type: "object", properties: { execution: { type: "object" } } },
  safetyLevel: "SAFE", source: "local", sourceId: "", actionCategory: "_default",
  policy: { version: TOOL_POLICY_VERSION, permission: { defaultDecision: "allow" },
    execution: { effect: "read", isolation: "shared_read", replay: "never" },
    context: { resultProjection: "preserve", historyCompaction: "summarize" } },
}, async args => args.execution
  ? { success: true, content: "参数已补全" }
  : { success: false, content: DIAGNOSTIC, error: "execution" })

let root = ""
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "deskpet-tool-diagnostic-"))
  setTestDataRoot(root)
  await initPaths()
})
beforeEach(async () => { await standardSetup(); register(probe) })
afterEach(() => { unregister(TOOL_ID); resetPiRuntimeProviderForTest() })
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

it("错误诊断进入下一次请求并原样落盘，修正后成功仍可区分 [tool-failure-diagnostic-preserved]", async () => {
  const provider = installFakeProvider([
    fakeToolCall(TOOL_NAME, {}, "missing-execution"),
    fakeToolCall(TOOL_NAME, { execution: { thinkingEffort: "low" } }, "repaired-execution"),
    fakeText("参数补全后完成"),
  ])
  const output = await runRuntimeTurn("检查工具缺参的诊断。")
  expect(output.failure).toBeUndefined()
  expect(output.toolCallHistory.map(row => row.status)).toEqual(["error", "done"])
  const nextRequest = provider.payloads[1]!.messages as readonly { role: string; toolName?: string; isError?: boolean; content: unknown }[]
  const projected = nextRequest.find(row => row.role === "toolResult" && row.toolName === TOOL_NAME)
  expect(projected).toMatchObject({ isError: true, content: [
    { type: "text", text: expect.stringContaining(`工具 ${TOOL_NAME} 失败：execution\n${DIAGNOSTIC}`) },
  ] })
  const entries = await readPiSessionEntriesOnce(getActiveSessionId())
  const results = entries.filter(entry => entry.type === "message" && entry.message.role === "toolResult"
    && entry.message.toolName === TOOL_NAME)
  expect(results).toHaveLength(2)
  expect(results[0]).toMatchObject({ message: { isError: true,
    content: [{ type: "text", text: `工具 ${TOOL_NAME} 失败：execution\n${DIAGNOSTIC}` }] } })
  expect(results[1]).toMatchObject({ message: { isError: false,
    content: [{ type: "text", text: "参数已补全" }] } })
}, 60_000)
