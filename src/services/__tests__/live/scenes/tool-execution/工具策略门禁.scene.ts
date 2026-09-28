import type { SceneDef } from "../../types"
import type { SafetyLevel, ToolDef, ToolPolicy } from "@/services/tool"
import { defineTool, register, unregister, getToolByName, TOOL_POLICY_VERSION } from "@/services/tool"
import { formatError } from "@/services/error"

/**
 * 策略门禁：缺策略、策略不一致、版本不支持、权限意见表外、风险声明表外都必须在
 * 构造/注册时报错，而不是缺省成可并行、可重放或某个默认权限。
 *
 * 拒绝原因一并断言：只判「抛了错」会让「因为别的原因失败」也算通过。
 * 策略版本当前是 2（安全等级到裁决结果的映射语义变了一次），所以 1 这一代声明
 * 连同旧授权一起失效 —— 这条与「当前版本可用」成对，钉住的是「旧声明不能按新表执行」。
 */
const base = {
  id: "policy-gate-probe", name: "policy_gate_probe", description: "策略门禁探针",
  parameters: { type: "object" as const, properties: {} },
  safetyLevel: "SAFE" as const, source: "local" as const, sourceId: "",
  actionCategory: "os.info" as const,
}

const policy = (over: Partial<ToolPolicy> = {}): ToolPolicy => ({
  version: TOOL_POLICY_VERSION,
  permission: { defaultDecision: "allow" },
  execution: { effect: "read", isolation: "shared_read", replay: "never" },
  context: { resultProjection: "reference", historyCompaction: "summarize" },
  ...over,
})

const handler = async () => ({ success: true, content: "ok" })

/** 取拒绝原因；「没被拒绝」本身就是断言失败，所以这里不吞错。 */
async function rejection(work: () => unknown): Promise<string> {
  try {
    await work()
  } catch (error) {
    return formatError(error)
  }
  throw new Error("声明没有被拒绝")
}

export const 工具策略门禁: SceneDef = {
  meta: {
    caseId: "tool-policy-registration-gate", module: "tool-execution", contractId: "te-15",
    description: "工具策略必须在构造与注册时完整一致，缺策略、shared_read 搭配非只读效果、未知版本或非法权限意见都视为注册错误",
    depth: "deep", suite: "safety", entry: "unit", tags: ["tool-execution", "safety", "error"],
  },
  turns: [{
    index: 1,
    description: "校验策略门禁与冻结语义",
    userText: "检查工具策略门禁。",
    checks: [{
      type: "expectPolicyGate",
      run: async () => {
        // 未经 defineTool 的原始定义：注册入口必须拒绝，不留下半个工具
        //（缺策略在 T4.02 之后由 defineTool 的校验兜住，注册入口这一层拦的是「没有执行体」）。
        const unconstructed = await rejection(() => register({ ...base, policy: policy() } as unknown as ToolDef))
        if (!unconstructed.includes("defineTool")) throw new Error(`未经 defineTool 构造的定义被拒绝，但原因不是构造点: ${unconstructed}`)
        if (getToolByName(base.name)) throw new Error("被拒绝的工具仍进入注册表")

        // shared_read 必须是只读能力：写效果配共享读必须报错，而不是被当成可并行。
        const sharedWrite = await rejection(() => defineTool({
          ...base, policy: policy({ execution: { effect: "local_mutation", isolation: "shared_read", replay: "never" } }),
        }, handler))
        if (!sharedWrite.includes("shared_read")) throw new Error(`shared_read + 写效果的拒绝原因不对: ${sharedWrite}`)

        // 未知策略版本不能按当前语义执行。
        const unknownVersion = await rejection(() => defineTool({ ...base, policy: policy({ version: TOOL_POLICY_VERSION + 1 }) }, handler))
        if (!unknownVersion.includes("策略版本不支持")) throw new Error(`未知策略版本的拒绝原因不对: ${unknownVersion}`)

        // 旧一代（版本 1）的声明在同一入口同样被拒：裁决映射语义变了，旧声明不能按新表跑。
        const retiredVersion = await rejection(() => defineTool({ ...base, policy: policy({ version: 1 }) }, handler))
        if (!retiredVersion.includes("策略版本不支持")) throw new Error(`版本 1 的声明被接受或拒绝原因不对: ${retiredVersion}`)

        // 权限意见必须是四选一，不能是任意字符串。
        const invalidDecision = await rejection(() => defineTool({
          ...base, policy: policy({ permission: { defaultDecision: "maybe" as unknown as ToolPolicy["permission"]["defaultDecision"] } }),
        }, handler))
        if (!invalidDecision.includes("defaultDecision")) throw new Error(`非法权限意见的拒绝原因不对: ${invalidDecision}`)

        // 风险声明校验守的是未经类型检查的适配器（`as` 断言绕过 SafetyLevel）：四级之外必须被拒。
        const invalidRisk = await rejection(() => defineTool({
          ...base, policy: policy(), safetyLevel: "SUPER_DANGER" as unknown as SafetyLevel,
        }, handler))
        if (!invalidRisk.includes("safetyLevel")) throw new Error(`表外安全等级的拒绝原因不对: ${invalidRisk}`)

        // 完整声明可用且被冻结：冻结后策略不会被就地改写。
        const tool = defineTool({ ...base, policy: policy() }, handler)
        if (!Object.isFrozen(tool) || !Object.isFrozen(tool.policy) || !Object.isFrozen(tool.policy.execution)) {
          throw new Error("完整工具声明没有被冻结")
        }
        register(tool)
        try {
          if (getToolByName(base.name)?.policy.execution.isolation !== "shared_read") throw new Error("注册后的策略不可读")
        } finally {
          unregister(tool.id)
        }
      },
    }],
  }],
}

export default 工具策略门禁
