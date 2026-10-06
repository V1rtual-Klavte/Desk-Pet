// ==========================================
// 计划提议指引进入系统提示 —— L2（纯上下文组装，不 import 引擎/会话/工具执行面）
// ==========================================
//
// 被测语义（用户 2026-10-06 裁决的第五条）：需要用户确认的多步操作必须走 propose_plan
// 请求确认，不能用 osascript / GUI 弹窗命令等待用户；这条中性说明只在提议工具真的在
// 本回合工具面里时注入 —— 子运行/窄工具集不该被告知一个不在场的工具。
//
// 区分力：删掉指引 → 正向断言红；把指引改成无条件注入 → 负向对照红。
// 工具名在测试里手写（线上契约的见证，不 import 实现常量）。

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { buildPrompt } from "@/services/context"
import { destroyPool, getPoolSnapshot } from "@/services/personality/variable-pool"
import type { ToolDeclaration } from "@/services/agent/types"

let root = ""

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "deskpet-plan-tool-prompt-"))
  setTestDataRoot(root)
  destroyPool()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function toolDecl(name: string): ToolDeclaration {
  return { type: "function", function: { name, description: "", parameters: { type: "object", properties: {} } } }
}

const BASE = {
  thinkingEffort: "low" as const,
  contextMaxTokens: 32_000,
  maxOutputTokens: 1_024,
  v1rtualInstructions: "",
  skillsPromptBlock: "",
  dynamicPrompt: "变量池文本",
}

describe("计划提议指引", () => {
  it("工具面里有 propose_plan 时注入中性指引（点名工具与弹窗禁令） [plan-tool-prompt-guidance]", () => {
    const context = buildPrompt({ ...BASE, tools: [toolDecl("read"), toolDecl("propose_plan")] }, null, getPoolSnapshot())

    expect(context.systemPrompt, "系统提示没有指引模型走计划确认工具").toContain("propose_plan")
    expect(context.systemPrompt, "系统提示没有禁止 GUI 弹窗等待用户").toContain("osascript")
    // 中性说明：不得写成角色台词（系统提示里的这句不是 Card 文案）。
    expect(context.systemPrompt, "指引混进了对话式台词").not.toContain("～")
  })

  it("工具面里没有 propose_plan 时不注入（窄工具集不该被告知不在场的工具） [plan-tool-prompt-absent]", () => {
    const context = buildPrompt({ ...BASE, tools: [toolDecl("read")] }, null, getPoolSnapshot())

    expect(context.systemPrompt, "不在场时仍宣传了 propose_plan").not.toContain("propose_plan")
    expect(context.systemPrompt, "不在场时仍宣传了弹窗禁令").not.toContain("osascript")
  })
})
