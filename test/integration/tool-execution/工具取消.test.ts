// ==========================================
// 工具取消 —— 从 test/e2e/scenes/tool-execution/工具取消.scene.ts 迁到 L3
// ==========================================
//
// 断言不进入模型：取消（已 abort 的 signal）在 router 里先于任何执行获准被判定 ——
// handler 不运行、返回稳定错误码 cancelled。原场景未声明 entry（默认 runtime），
// 会为这三条进程内断言真驱动一次模型；迁到 L3 后直接以 vitest 执行。
//
// 归属 L3（不是 L2）的理由：import `@/services/tool`（工具 barrel 会带出执行许可，
// 规则 6 的 L2 禁入清单）。
//
// 取消判定的两条通道在 Node 下的可辨形态：router 的 abort 早退（本用例覆盖）之外，
// `acquireToolPermit` 也会把已 abort 的等待直接判 cancelled —— 后者依赖 Rust 许可内核，
// 只在 L4 侧有覆盖（执行许可场景）。本文件钉的是契约 te-10 的「不进入 handler + 稳定错误码」。
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { setTestDataRoot } from "../../host/node-ipc"
import { defineTool, register, TOOL_POLICY_VERSION, unregister } from "@/services/tool"
import { getToolByName } from "@/services/tool/registry"
import { executeToolDefinition } from "@/services/tool/router"

const TOOL_ID = "live-cancelled-tool"

let root = ""

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "deskpet-tool-execution-cancelled-"))
  setTestDataRoot(root)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("工具取消", () => {
  it("取消工具调用不进入 handler 且返回稳定错误码 [tool-cancelled]", async () => {
    let called = false
    register(defineTool({
      id: TOOL_ID, name: TOOL_ID, description: "test", parameters: { type: "object", properties: {} },
      safetyLevel: "SAFE", source: "local", sourceId: "", actionCategory: "_default",
      policy: {
        version: TOOL_POLICY_VERSION,
        permission: { defaultDecision: "allow" },
        execution: { effect: "read", isolation: "shared_read", replay: "never" },
        context: { resultProjection: "reference", historyCompaction: "summarize" },
      },
    }, async () => { called = true; return { success: true, content: "unexpected" } }))

    try {
      const controller = new AbortController()
      controller.abort()
      const result = await executeToolDefinition(getToolByName(TOOL_ID)!, {}, { signal: controller.signal })
      expect(called, "取消的工具调用仍进入了 handler").toBe(false)
      expect(result.success, "取消的工具调用被报告成功").toBe(false)
      expect(result.errorCode, "取消的稳定错误码不是 cancelled").toBe("cancelled")
    } finally {
      unregister(TOOL_ID)
    }
  })
})
