import { buildPrompt, CHAT_THINKING_HINTS, composeDynamicPrompt, estimateContextTokens, ONE_SHOT_LOW_EFFORT_HINT } from "@/services/context"
import { formatPoolForPrompt } from "@/services/personality/variable-pool"
import type { VariablePool } from "@/services/personality/variable-pool"
import type { SceneDef } from "../../types"

/** 最小变量池：这里校验的是拼接口径，池正文内容不参与断言。 */
const POOL: VariablePool = { system: {}, card: {}, interaction: {} }

// 动态提示的文案此前散在三处（context/builder、engine/pi/runtime、engine/pi/model-gateway）：
// 改一处就分叉，而且没有任何断言拦它。这个场景钉住「只有一处定义」这件事本身。
export const 提示文案: SceneDef = {
  meta: {
    caseId: "memory-prompt-composition",
    module: "memory",
    contractId: "mm-29",
    description: "动态提示与思考强度文案只有一处定义：composeDynamicPrompt + CHAT_THINKING_HINTS；一次性调用的低强度兜底提示是另一个常量",
    depth: "shallow",
    suite: "regression",
    entry: "unit",
    tags: ["memory", "context"],
  },
  turns: [{
    index: 1,
    description: "校验拼接口径、两个用途的文案差异与 buildPrompt 的真实接线",
    userText: "校验动态提示文案的唯一定义点。",
    checks: [{
      type: "expectDynamicPromptSingleDefinition",
      run: async () => {
        const poolText = formatPoolForPrompt(POOL)

        // 1. 拼接口径：low/high 各带自己的后缀，其余档位原样返回。
        const low = composeDynamicPrompt(poolText, "low")
        if (!low.startsWith(poolText)) throw new Error(`低强度提示不以池正文开头: ${JSON.stringify(low)}`)
        if (!low.includes(CHAT_THINKING_HINTS.low)) throw new Error(`低强度提示缺少 low 后缀: ${JSON.stringify(low)}`)
        const high = composeDynamicPrompt(poolText, "high")
        if (!high.startsWith(poolText) || !high.includes(CHAT_THINKING_HINTS.high)) {
          throw new Error(`高强度提示拼接不正确: ${JSON.stringify(high)}`)
        }
        for (const effort of ["auto", "medium"] as const) {
          const composed = composeDynamicPrompt(poolText, effort)
          if (composed !== poolText) throw new Error(`${effort} 档位不应追加后缀: ${JSON.stringify(composed)}`)
        }

        // 2. 两个用途的文案必须不同：一次性调用是「端点不认 reasoning_effort」的兜底，
        //    聊天提示是回合的强度指令，合并会让其中一边失去自己的语义。
        if (ONE_SHOT_LOW_EFFORT_HINT === CHAT_THINKING_HINTS.low) {
          throw new Error("一次性调用的低强度提示与聊天提示相同，两个用途的语义被合并了")
        }
        if (estimateContextTokens(ONE_SHOT_LOW_EFFORT_HINT) <= 0) {
          throw new Error("一次性调用的低强度提示估算为 0 token")
        }

        // 3. 接线：常量被真实消费（不是死导出）—— 不传 dynamicPrompt 时由 buildPrompt 自己拼。
        const built = buildPrompt({
          thinkingEffort: "high",
          tools: [],
          contextMaxTokens: 131_072,
          candyInstructions: "",
          userProfileText: "",
          skillsPromptBlock: "",
        }, null, POOL)
        if (!built.systemPrompt.includes(CHAT_THINKING_HINTS.high)) {
          throw new Error("buildPrompt 的系统提示没有消费 CHAT_THINKING_HINTS.high")
        }
      },
    }],
  }],
}

export default 提示文案
