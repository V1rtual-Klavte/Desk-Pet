import type { SceneDef } from "../../types"
import type { ToolDef, ToolHandler } from "@/services/tool"
import { defineTool, register, unregister, getToolByName, TOOL_POLICY_VERSION } from "@/services/tool"
import { getToolHandler } from "@/services/tool/policy"
import { formatError } from "@/services/error"

/**
 * 构造门禁：执行函数不是 `ToolDef` 的公开字段，`defineTool` 是唯一带执行体的构造入口。
 *
 * 这条口径不能只靠约定：字段齐全的原始定义在类型上仍然是合法 `ToolDef`，
 * 若注册入口不拦，没有执行体的定义会进入注册表，直到执行时才以「工具没有执行体」暴露。
 * 所以断言分三层：定义绕过构造点必须被注册入口拒绝；构造产物不带 `handler` 字段且被冻结；
 * 执行体只经模块内 WeakMap 可取。
 */
const NAME = "tool_construction_gate_probe"

/** 完整的工具声明：字段合法、类型合法，只是没有走 `defineTool`。 */
const declaration = {
  id: "tool-construction-gate", name: NAME, description: "构造门禁探针",
  parameters: { type: "object" as const, properties: {} },
  safetyLevel: "SAFE" as const, source: "local" as const, sourceId: "", mode: "pet" as const,
  actionCategory: "os.info" as const,
  policy: {
    version: TOOL_POLICY_VERSION,
    permission: { defaultDecision: "allow" as const },
    execution: { effect: "read" as const, isolation: "shared_read" as const, replay: "never" as const },
    context: { resultProjection: "reference" as const, historyCompaction: "summarize" as const },
  },
}

const handler: ToolHandler = async () => ({ success: true, content: "ok" })

export const 工具构造门禁: SceneDef = {
  meta: {
    caseId: "tool-define-only-construction", module: "tool-execution", contractId: "te-15",
    description: "defineTool 是唯一携带执行体的构造入口：绕过它的定义在注册时被拒且不进注册表，执行函数不在公开字段里",
    depth: "shallow", suite: "safety", entry: "unit", tags: ["tool-execution", "boundary", "error"],
  },
  turns: [{
    index: 1,
    description: "校验构造门禁与执行体的存放位置",
    userText: "检查工具构造门禁。",
    checks: [{
      type: "expectToolConstructionGate",
      run: async () => {
        // ① 绕过 defineTool 的定义必须被注册入口拒绝（错误信息点名 defineTool），且不留下半个工具。
        let rejection = ""
        try {
          register({ ...declaration })
        } catch (error) {
          rejection = formatError(error)
        }
        if (!rejection.includes("defineTool")) {
          throw new Error(`未经 defineTool 构造的定义没有被拒绝: ${rejection || "<未抛错>"}`)
        }
        if (getToolByName(NAME)) throw new Error("被拒绝的工具仍进入注册表")

        // ② 执行体不在公开字段上，构造产物被冻结（调用方拿不到可变副本）。
        const tool = defineTool({ ...declaration }, handler)
        if ("handler" in tool) throw new Error("执行函数仍是 ToolDef 的公开字段")
        if (!Object.isFrozen(tool)) throw new Error("defineTool 的产物没有被冻结")

        // ③ 执行体只经模块内 WeakMap 可取：表外对象读不到，构造产物读到的是同一个函数。
        if (getToolHandler({ ...declaration }) !== undefined) throw new Error("表外定义读到了执行体")
        if (getToolHandler(tool) !== handler) throw new Error("defineTool 的产物没有绑定执行体")

        // ④ 唯一构造点的产物必须仍可正常注册（门禁拦的是绕过者，不是所有定义）。
        register(tool)
        try {
          if (getToolByName(NAME) !== tool) throw new Error("defineTool 的产物未能注册")
        } finally {
          unregister(tool.id)
        }
      },
    }],
  }],
}

export default 工具构造门禁
