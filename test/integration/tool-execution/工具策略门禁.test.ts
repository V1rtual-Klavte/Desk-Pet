// ==========================================
// 工具策略门禁 —— 从 test/e2e/scenes/tool-execution/工具策略门禁.scene.ts 迁到 L3
// ==========================================
//
// 策略门禁：缺策略、策略不一致、版本不支持、权限意见表外、风险声明表外都必须在
// 构造/注册时报错，而不是缺省成可并行、可重放或某个默认权限。
//
// 拒绝原因一并断言：只判「抛了错」会让「因为别的原因失败」也算通过。
// 策略版本当前是 2（安全等级到裁决结果的映射语义变了一次），所以 1 这一代声明
// 连同旧授权一起失效 —— 这条与「当前版本可用」成对，钉住的是「旧声明不能按新表执行」。
//
// 归属 L3（不是 L2）的理由：`@/services/tool` 是带 IPC 的模块入口（规则 6 判据），
// 但本文件只在进程内构造/注册探针，不触发任何 Rust 命令。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { setTestDataRoot } from "../../host/node-ipc"
import { formatError } from "@/services/error"
import type { SafetyLevel, ToolDef, ToolPolicy } from "@/services/tool"
import { defineTool, getToolByName, register, TOOL_POLICY_VERSION, unregister } from "@/services/tool"

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

/** 取拒绝原因；「没被拒绝」本身就是断言失败，所以这里不吞错（expect 记在调用点）。 */
async function rejection(work: () => unknown): Promise<string> {
  let reason: string | undefined
  try {
    await work()
  } catch (error) {
    reason = formatError(error)
  }
  expect(reason, "声明没有被拒绝").toBeDefined()
  return reason!
}

let root = ""

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "deskpet-tool-execution-policy-gate-"))
  setTestDataRoot(root)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("工具策略门禁", () => {
  it("缺策略、shared_read 配写效果、未知版本、非法权限意见、表外风险等级都被拒；完整声明被冻结 [tool-policy-registration-gate]", async () => {
    // 未经 defineTool 的原始定义：注册入口必须拒绝，不留下半个工具
    //（缺策略在 T4.02 之后由 defineTool 的校验兜住，注册入口这一层拦的是「没有执行体」）。
    const unconstructed = await rejection(() => register({ ...base, policy: policy() } as unknown as ToolDef))
    expect(unconstructed).toContain("defineTool")
    expect(getToolByName(base.name)).toBeUndefined()

    // shared_read 必须是只读能力：写效果配共享读必须报错，而不是被当成可并行。
    const sharedWrite = await rejection(() => defineTool({
      ...base, policy: policy({ execution: { effect: "local_mutation", isolation: "shared_read", replay: "never" } }),
    }, handler))
    expect(sharedWrite).toContain("shared_read")

    // 未知策略版本不能按当前语义执行。
    const unknownVersion = await rejection(() => defineTool({ ...base, policy: policy({ version: TOOL_POLICY_VERSION + 1 }) }, handler))
    expect(unknownVersion).toContain("策略版本不支持")

    // 旧一代（版本 1）的声明在同一入口同样被拒：裁决映射语义变了，旧声明不能按新表跑。
    const retiredVersion = await rejection(() => defineTool({ ...base, policy: policy({ version: 1 }) }, handler))
    expect(retiredVersion).toContain("策略版本不支持")

    // 权限意见必须是四选一，不能是任意字符串。
    const invalidDecision = await rejection(() => defineTool({
      ...base, policy: policy({ permission: { defaultDecision: "maybe" as unknown as ToolPolicy["permission"]["defaultDecision"] } }),
    }, handler))
    expect(invalidDecision).toContain("defaultDecision")

    // 风险声明校验守的是未经类型检查的适配器（`as` 断言绕过 SafetyLevel）：四级之外必须被拒。
    const invalidRisk = await rejection(() => defineTool({
      ...base, policy: policy(), safetyLevel: "SUPER_DANGER" as unknown as SafetyLevel,
    }, handler))
    expect(invalidRisk).toContain("safetyLevel")

    // 完整声明可用且被冻结：冻结后策略不会被就地改写。
    const tool = defineTool({ ...base, policy: policy() }, handler)
    expect(Object.isFrozen(tool)).toBe(true)
    expect(Object.isFrozen(tool.policy)).toBe(true)
    expect(Object.isFrozen(tool.policy.execution)).toBe(true)
    register(tool)
    try {
      expect(getToolByName(base.name)?.policy.execution.isolation).toBe("shared_read")
    } finally {
      unregister(tool.id)
    }
  })
})
