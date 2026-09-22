import type { SceneDef } from "../../types"
import type { ToolDef, ToolPolicy } from "@/services/tool"
import { defineTool, register, unregister, getToolByName, TOOL_POLICY_VERSION } from "@/services/tool"

/**
 * 策略门禁：缺策略、策略不一致、版本不支持都必须在构造/注册时报错，
 * 而不是缺省成可并行、可重放或某个默认权限。
 */
const base = {
  id: "policy-gate-probe", name: "policy_gate_probe", description: "策略门禁探针",
  parameters: { type: "object" as const, properties: {} },
  safetyLevel: "SAFE" as const, source: "local" as const, sourceId: "", mode: "pet" as const,
  actionCategory: "os.info" as const,
}

const policy = (over: Partial<ToolPolicy> = {}): ToolPolicy => ({
  version: TOOL_POLICY_VERSION,
  permission: { defaultDecision: "allow" },
  execution: { effect: "read", mode: "parallel", isolation: "shared_read", replay: "never" },
  context: { resultProjection: "reference", historyCompaction: "summarize" },
  ...over,
})

const handler = async () => ({ success: true, content: "ok" })

async function throws(run: () => unknown): Promise<boolean> {
  try {
    await run()
    return false
  } catch {
    return true
  }
}

export const 工具策略门禁: SceneDef = {
  meta: {
    caseId: "tool-policy-registration-gate", module: "tool-execution", contractId: "te-15",
    description: "工具策略必须在构造与注册时完整一致，缺策略或非只读并行视为注册错误",
    depth: "deep", suite: "safety", entry: "unit", tags: ["tool-execution", "safety", "error"],
  },
  turns: [{
    index: 1,
    description: "校验策略门禁与冻结语义",
    userText: "检查工具策略门禁。",
    checks: [{
      type: "expectPolicyGate",
      run: async () => {
        // 缺策略：注册入口必须拒绝，不留下半个工具。
        if (!await throws(() => register({ ...base } as unknown as ToolDef))) throw new Error("缺少 policy 的工具被注册")
        if (getToolByName(base.name)) throw new Error("被拒绝的工具仍进入注册表")

        // parallel 不是只读能力：必须报错，而不是被当成可并行。
        if (!await throws(() => defineTool({ ...base, policy: policy({ execution: { effect: "local_mutation", mode: "parallel", isolation: "shared_read", replay: "never" } }) }, handler))) {
          throw new Error("parallel + 写效果被接受")
        }
        // 独占效果必须串行。
        if (!await throws(() => defineTool({ ...base, policy: policy({ execution: { effect: "local_mutation", mode: "parallel", isolation: "exclusive_effect", replay: "never" } }) }, handler))) {
          throw new Error("parallel + exclusive_effect 被接受")
        }
        // 未知策略版本不能按当前语义执行。
        if (!await throws(() => defineTool({ ...base, policy: policy({ version: TOOL_POLICY_VERSION + 1 }) }, handler))) {
          throw new Error("未知策略版本被接受")
        }
        // 权限意见必须是四选一，不能是任意字符串。
        if (!await throws(() => defineTool({ ...base, policy: policy({ permission: { defaultDecision: "maybe" as unknown as ToolPolicy["permission"]["defaultDecision"] } }) }, handler))) {
          throw new Error("非法权限意见被接受")
        }

        // 完整声明可用且被冻结：冻结后策略不会被就地改写。
        const tool = defineTool({ ...base, policy: policy() }, handler)
        if (!Object.isFrozen(tool) || !Object.isFrozen(tool.policy) || !Object.isFrozen(tool.policy.execution)) {
          throw new Error("完整工具声明没有被冻结")
        }
        register(tool)
        try {
          if (getToolByName(base.name)?.policy.execution.mode !== "parallel") throw new Error("注册后的策略不可读")
        } finally {
          unregister(tool.id)
        }
      },
    }],
  }],
}

export default 工具策略门禁
