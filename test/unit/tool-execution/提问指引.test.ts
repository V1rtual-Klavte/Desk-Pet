// ==========================================
// 提问选择指引进入系统提示 —— L2（纯上下文组装，不 import 引擎/会话/工具执行面）
// ==========================================
//
// 被测语义（用户 2026-10-06 二次裁决的第五条）：需要用户做决定时必须用 ask_user
// 给出问题与选项（用户也能选「其它」自由回答），不要用文字在回复里先征求同意；
// 权限类动作仍照现状直接执行（危险动作由确认面板当场确认）。指引只在**工具面真的
// 含该工具**时注入 —— 子运行/窄工具集不该被告知一个不在场的工具。
//
// 区分力：删掉指引 → 正向断言红；改成无条件注入 → 负向对照红；把旧句
//「单个动作需要确认时直接执行」加回来 → 该断言红。
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
  root = mkdtempSync(join(tmpdir(), "deskpet-ask-tool-prompt-"))
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

describe("提问选择指引", () => {
  it("工具面里有 ask_user 时注入中性指引（点名工具、说清「其它」与权限类动作照旧） [ask-tool-prompt-guidance]", () => {
    const context = buildPrompt({ ...BASE, tools: [toolDecl("read"), toolDecl("ask_user")] }, null, getPoolSnapshot())

    expect(context.systemPrompt, "系统提示没有指引模型用提问工具").toContain("ask_user")
    expect(context.systemPrompt, "没有说明用户可以选「其它」自由回答").toContain("其它")
    expect(context.systemPrompt, "没有禁止用文字先征求同意").toContain("不要用文字先征求同意")
    expect(context.systemPrompt, "权限类动作的直接执行口径丢了").toContain("权限类动作照常直接执行")
    // 旧句方向是错的（用户要的是「问」不是闷头做）：它必须退场。
    expect(context.systemPrompt, "旧句「单个动作需要确认时直接执行」还在").not.toContain("单个动作需要确认时直接执行")
    // GUI 弹窗禁令在有咨询工具在场时仍要注入。
    expect(context.systemPrompt, "没有禁止 GUI 弹窗等待用户").toContain("osascript")
    // 不在场的工具不宣传（按工具名逐句注入）。
    expect(context.systemPrompt, "工具面没有 propose_plan 却提了它").not.toContain("propose_plan")
    // 中性说明：不得写成角色台词。
    expect(context.systemPrompt, "指引混进了对话式台词").not.toContain("～")
  })

  it("工具面里没有咨询工具时不注入（窄工具集不该被告知不在场的工具） [ask-tool-prompt-absent]", () => {
    const context = buildPrompt({ ...BASE, tools: [toolDecl("read")] }, null, getPoolSnapshot())

    expect(context.systemPrompt, "不在场时仍宣传了 ask_user").not.toContain("ask_user")
    expect(context.systemPrompt, "不在场时仍宣传了「其它」").not.toContain("其它")
    expect(context.systemPrompt, "不在场时仍宣传了弹窗禁令").not.toContain("osascript")
  })

  it("两个咨询工具都在场时两句指引都在、各点名自己的工具 [ask-tool-prompt-both]", () => {
    const context = buildPrompt(
      { ...BASE, tools: [toolDecl("read"), toolDecl("propose_plan"), toolDecl("ask_user")] },
      null,
      getPoolSnapshot(),
    )

    expect(context.systemPrompt, "多步计划的指引丢了").toContain("propose_plan")
    expect(context.systemPrompt, "提问的指引丢了").toContain("ask_user")
    expect(context.systemPrompt, "弹窗禁令丢了").toContain("osascript")
  })
})
