// ==========================================
// 工具构造门禁 —— 从 test/e2e/scenes/tool-execution/工具构造门禁.scene.ts 迁到 L3
// ==========================================
//
// 构造门禁：执行函数不是 `ToolDef` 的公开字段，`defineTool` 是唯一带执行体的构造入口。
//
// 这条口径不能只靠约定：字段齐全的原始定义在类型上仍然是合法 `ToolDef`，
// 若注册入口不拦，没有执行体的定义会进入注册表，直到执行时才以「工具没有执行体」暴露。
// 所以断言分三层：定义绕过构造点必须被注册入口拒绝；构造产物不带 `handler` 字段且被冻结；
// 执行体只经模块内 WeakMap 可取。
//
// 归属 L3（不是 L2）的理由：`@/services/tool` 是带 IPC 的模块入口（规则 6 判据），
// 但本文件只在进程内构造/注册探针，不触发任何 Rust 命令。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { formatError } from "@/services/error"
import type { ToolHandler } from "@/services/tool"
import { defineTool, getToolByName, register, TOOL_POLICY_VERSION, unregister } from "@/services/tool"
import { getToolHandler } from "@/services/tool/policy"

const NAME = "tool_construction_gate_probe"

/** 完整的工具声明：字段合法、类型合法，只是没有走 `defineTool`。 */
const declaration = {
  id: "tool-construction-gate", name: NAME, description: "构造门禁探针",
  parameters: { type: "object" as const, properties: {} },
  safetyLevel: "SAFE" as const, source: "local" as const, sourceId: "",
  actionCategory: "os.info" as const,
  policy: {
    version: TOOL_POLICY_VERSION,
    permission: { defaultDecision: "allow" as const },
    execution: { effect: "read" as const, isolation: "shared_read" as const, replay: "never" as const },
    context: { resultProjection: "reference" as const, historyCompaction: "summarize" as const },
  },
}

const handler: ToolHandler = async () => ({ success: true, content: "ok" })

let root = ""

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "deskpet-tool-execution-construction-gate-"))
  setTestDataRoot(root)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("工具构造门禁", () => {
  it("绕过 defineTool 的定义在注册时被拒且不进注册表；执行体不在公开字段里 [tool-define-only-construction]", async () => {
    // ① 绕过 defineTool 的定义必须被注册入口拒绝（错误信息点名 defineTool），且不留下半个工具。
    let rejection: string | undefined
    try {
      register({ ...declaration })
    } catch (error) {
      rejection = formatError(error)
    }
    expect(rejection, `未经 defineTool 构造的定义没有被拒绝: ${rejection || "<未抛错>"}`).toBeDefined()
    expect(rejection).toContain("defineTool")
    expect(getToolByName(NAME)).toBeUndefined()

    // ② 执行体不在公开字段上，构造产物被冻结（调用方拿不到可变副本）。
    const tool = defineTool({ ...declaration }, handler)
    expect("handler" in tool).toBe(false)
    expect(Object.isFrozen(tool)).toBe(true)

    // ③ 执行体只经模块内 WeakMap 可取：表外对象读不到，构造产物读到的是同一个函数。
    expect(getToolHandler({ ...declaration })).toBeUndefined()
    expect(getToolHandler(tool)).toBe(handler)

    // ④ 唯一构造点的产物必须仍可正常注册（门禁拦的是绕过者，不是所有定义）。
    register(tool)
    try {
      expect(getToolByName(NAME)).toBe(tool)
    } finally {
      unregister(tool.id)
    }
  })
})
