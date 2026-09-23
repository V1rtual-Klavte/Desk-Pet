import { setSessionSafetyMode, resetSessionSafetyMode } from "@/services/debug"
import { initChat, sendMessage } from "@/services/agent/runner"
import { setOverride } from "@/services/config"
import { defineTool, register, unregister, TOOL_POLICY_VERSION } from "@/services/tool"
import type { ToolDef } from "@/services/tool"
import { registerBlockingTool } from "../../blocking-tool"
import { confirmRecords } from "../../confirm-channel"
import { fakeText, fakeToolCall, installFakeProvider } from "../../fake-provider"
import type { SceneDef } from "../../types"

// ── 场景口径：权限策略按回合冻结 ──
//
// 裁决与授权哈希必须来自同一份策略快照：回合开始时取一次，回合中改安全模式从下一回合生效。
// 这里在同一个回合里先以 just_do_it 放行一个 DANGER 探针，随后在阻塞工具的窗口里把会话安全模式
// 改成 let_me_tk，放行后第二个探针仍然被放行（冻结策略）且没有产生任何确认请求；对照组新开一轮，
// 同一探针进入 ask 并被测试宿主的确认策略拒绝。
//
// 回合内翻转必须由场景自己驱动（框架的断言在回合结束之后才跑），所以冻结回合在 setup 里跑完。

const PROBE_A = "live_pf_probe_a"
const PROBE_B = "live_pf_probe_b"
const BLOCK = "live_pf_block"

/** DANGER 探针：标准决策随安全模式变化（just_do_it 放行 / let_me_tk 询问），工具侧不另设意见。 */
function probeTool(name: string): ToolDef {
  return defineTool({
    id: `live-${name}`,
    name,
    description: `Live Test permission-freeze probe ${name}`,
    parameters: { type: "object", properties: {} },
    safetyLevel: "DANGER",
    lightweightPolicy: "confirm",
    source: "local",
    sourceId: "",
    mode: "assistant",
    actionCategory: "_default",
    policy: {
      version: TOOL_POLICY_VERSION,
      permission: { defaultDecision: "passthrough" },
      execution: { effect: "external_side_effect", isolation: "exclusive_effect", replay: "never" },
      context: { resultProjection: "reference", historyCompaction: "summarize" },
    },
  }, async (): Promise<{ success: boolean; content: string }> => ({ success: true, content: `${name} 执行完成` }))
}

let provider: ReturnType<typeof installFakeProvider> | undefined
let blocking: ReturnType<typeof registerBlockingTool> | undefined
let frozenStatuses: string[] = []
let confirmsInFrozenTurn = -1
let flippedDuringTurn = false

export const 权限策略冻结: SceneDef = {
  meta: {
    caseId: "memory-permission-freeze",
    module: "safety",
    contractId: "sf-19",
    description: "回合内改安全模式不改变本回合裁决：冻结策略下 DANGER 探针仍被放行，从下一回合才进入确认",
    depth: "deep",
    suite: "safety",
    entry: "production",
    tags: ["safety", "boundary"],
    confirmPolicy: "deny",
  },
  setup: async () => {
    // 助手模式：DANGER 的 just_do_it 放行分支只在助手模式下参与（pet 模式恒 ask/deny）。
    setOverride("general.mode.assistant", true)
    // 计划段会让这一轮先去规划（并消费脚本响应）：本场景只验证权限策略，显式关掉。
    setOverride("ai.plan.enabled", false)
    register(probeTool(PROBE_A))
    register(probeTool(PROBE_B))
    blocking = registerBlockingTool(BLOCK)
    provider = installFakeProvider([
      fakeToolCall(PROBE_A, {}, "pf-a"),
      fakeToolCall(BLOCK, {}, "pf-block"),
      fakeToolCall(PROBE_B, {}, "pf-b"),
      fakeText("冻结回合完成"),
    ])
    await initChat()
    setSessionSafetyMode("just_do_it")
    try {
      const frozenTurn = sendMessage("先做一次危险操作，再让阻塞工具等一会儿。")
      await blocking.started
      // 回合中改设置：正在跑的回合必须继续用回合开始冻结的策略。
      setSessionSafetyMode("let_me_tk")
      flippedDuringTurn = true
      blocking.release()
      const result = await frozenTurn
      frozenStatuses = result.toolCalls.map(item => `${item.toolName}:${item.status}`)
      confirmsInFrozenTurn = confirmRecords().length
    } finally {
      blocking.dispose()
    }
    // 对照回合的脚本：同一探针再调一次，随后收尾。
    provider.appendResponses([fakeToolCall(PROBE_B, {}, "pf-b2"), fakeText("对照回合完成")])
  },
  turns: [
    {
      index: 1,
      description: "对照回合：仍 let_me_tk，同一探针进入确认并被拒绝",
      userText: "再做一次同样的危险操作。",
      checks: [
        { type: "expectFrozenPolicyHeld", run: async () => {
          if (!flippedDuringTurn) throw new Error("回合内没有改安全模式，冻结的前提不成立")
          if (frozenStatuses.join(",") !== `${PROBE_A}:done,${BLOCK}:done,${PROBE_B}:done`) {
            throw new Error(`冻结策略下探针没有全部放行: ${JSON.stringify(frozenStatuses)}`)
          }
          if (confirmsInFrozenTurn !== 0) {
            throw new Error(`冻结回合里产生了 ${confirmsInFrozenTurn} 次确认请求（just_do_it 下 DANGER 应直接放行）`)
          }
        } },
        { type: "expectNextTurnReasks", run: async context => {
          const probeB = context.output.toolCallHistory.filter(item => item.toolName === PROBE_B)
          if (probeB.length !== 1) throw new Error(`对照回合的探针调用数不是 1: ${JSON.stringify(context.output.toolCallHistory)}`)
          if (probeB[0]!.status !== "denied") {
            throw new Error(`下一回合的同一探针没有进入确认并被拒绝: ${JSON.stringify(probeB)}`)
          }
          const confirms = confirmRecords().filter(record => record.toolName === PROBE_B)
          if (confirms.length !== 1 || confirms[0]!.approved) {
            throw new Error(`对照回合的确认记录不是「一次、被拒」: ${JSON.stringify(confirms)}`)
          }
        } },
        { type: "expectPolicyReset", run: async () => {
          // 会话安全模式是跨场景状态：显式复原（探针工具同理，不在 setup 里注销 —— 对照回合还要用它）。
          resetSessionSafetyMode()
          unregister(`live-${PROBE_A}`)
          unregister(`live-${PROBE_B}`)
        } },
      ],
    },
  ],
}

export default 权限策略冻结
