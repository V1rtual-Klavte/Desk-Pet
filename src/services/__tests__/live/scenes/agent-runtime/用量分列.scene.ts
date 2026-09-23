import type { Context, FauxResponseStep, Model } from "@earendil-works/pi-ai"
import { createAssistantMessageEventStream, fauxText } from "@earendil-works/pi-ai"
import { initChat } from "@/services/agent/runner"
import { evaluateComplexity, generatePlan } from "@/services/engine/planner"
import { getPiRuntimeProviderOverride, installPiRuntimeProviderForTest } from "@/services/engine/pi"
import { debug, usageGrandTotal } from "@/services/debug"
import type { PurposeUsage } from "@/services/debug"
import { getToolsForMode } from "@/services/tool"
import { installFakeProvider, fakeText } from "../../fake-provider"
import type { SceneDef } from "../../types"

// 一次性调用（压缩/规划/记忆整理/阶段文案）与主回合共用同一份分列统计：
// 主回合逐请求 usage 记 main，一次性调用经 completePiText 按自己的 purpose 记账。
// 这里用规划调用作驱动 —— 它与压缩走同一个通道，但不需要先堆出可压缩的历史。

const PLAN_USER_TEXT = "顺手把配置改一下"

const PLAN_JSON = '```json\n{"summary":"两步","steps":[{"id":1,"description":"读取配置"},{"id":2,"description":"改写配置"}]}\n```'

function lastRequestText(context: Context): string {
  const last = context.messages[context.messages.length - 1]
  return typeof last?.content === "string"
    ? last.content
    : (last?.content ?? []).map(part => (part.type === "text" ? part.text : "")).join("")
}

/** 规划脚本响应：被别的请求取走就是脚本错位，立即报错。 */
function planStep(): FauxResponseStep {
  return context => {
    const text = lastRequestText(context)
    if (!text.includes("用户请求:")) throw new Error(`规划脚本被非规划请求取走: ${text.slice(0, 60)}`)
    return fakeText(PLAN_JSON)
  }
}

/**
 * Provider 未回报 usage 的失败响应。
 * fake provider 会给每个响应补算 usage，所以这里手工构造一条全 0 的失败消息：
 * 统计必须只记调用次数，不能把 0 当准确用量。
 */
function installUnreportedErrorProvider(): void {
  const model = getPiRuntimeProviderOverride()?.model
  if (!model) throw new Error("先安装 fake provider 再装未回报 usage 的失败响应")
  installPiRuntimeProviderForTest({
    model,
    streamFn: (requestModel: Model<any>) => {
      const stream = createAssistantMessageEventStream()
      stream.end({
        role: "assistant", content: [], api: requestModel.api, provider: requestModel.provider, model: requestModel.id,
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error", errorMessage: "boom", timestamp: Date.now(),
      })
      return stream
    },
  })
}

function planInput(): Parameters<typeof generatePlan>[1] {
  return {
    cardId: "usage-scene",
    cardRole: "助手",
    availableTools: getToolsForMode("assistant"),
    thinkingEffort: "low",
    maxSteps: 8,
  }
}

/**
 * 分项独立求和，再和 usageGrandTotal() 对账。
 * 测试自己算一遍才知道「总量与分项同源」不是靠同一个函数自证。
 */
function summedBuckets(): PurposeUsage {
  const summed: PurposeUsage = { calls: 0, reported: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  for (const bucket of Object.values(debug.usage)) {
    summed.calls += bucket.calls
    summed.reported += bucket.reported
    summed.input += bucket.input
    summed.output += bucket.output
    summed.cacheRead += bucket.cacheRead
    summed.cacheWrite += bucket.cacheWrite
    summed.total += bucket.total
  }
  return summed
}

export const 用量分列: SceneDef = {
  meta: {
    caseId: "runtime-usage-purpose-split",
    module: "agent-runtime",
    contractId: "ar-07",
    description: "主回合与一次性调用的用量分列：一次性调用单独计数、不冒充主回合、总量仍包含它们",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["production-entry", "usage", "planner", "error"],
  },
  setup: async () => {
    installFakeProvider([fakeText("第一轮回复完成。"), fakeText("第二轮回复完成。"), planStep()])
    await initChat()
  },
  turns: [
    { index: 1, description: "主回合产生一次逐请求 usage", userText: "第一轮：先产生一次主回合用量。", checks: [
      { type: "expectUsageMainRound", run: async () => {
        const main = debug.usage.main
        if (main.calls === 0) throw new Error("主回合用量没有记录调用次数")
        if (main.reported === 0 || main.input <= 0) throw new Error("主回合没有累加 Provider 回报的 token")
        // last 统计归主回合：这次回合之后它是最后一次真实请求
        if (debug.lastPromptTokens <= 0) throw new Error("主回合的 Provider usage 没有进入 last 统计")
      } },
    ] },
    { index: 2, description: "一次性调用单独计数，且总量仍包含它", userText: "第二轮：核对一次性调用的用量分列。", checks: [
      { type: "expectUsagePurposeSplit", run: async () => {
        const mainBefore = { ...debug.usage.main }
        const lastPromptBefore = debug.lastPromptTokens
        const plannerBefore = { ...debug.usage.planner }

        const plan = await generatePlan(PLAN_USER_TEXT, planInput())
        if (plan.steps.length !== 2) throw new Error(`规划脚本没有被规划调用消费（${plan.steps.length} 步）`)

        const plannerAfter = debug.usage.planner
        if (plannerAfter.calls !== plannerBefore.calls + 1) throw new Error("一次性调用没有单独计数")
        if (plannerAfter.reported !== plannerBefore.reported + 1) throw new Error("一次性调用没有被记为 Provider 已回报")
        if (plannerAfter.input <= plannerBefore.input) throw new Error("一次性调用没有累加 input token")

        // 分离：一次性调用既不改主回合分项，也不覆盖主回合的 last 统计
        if (debug.usage.main.calls !== mainBefore.calls || debug.usage.main.input !== mainBefore.input) {
          throw new Error("一次性调用混进了主回合统计")
        }
        if (debug.lastPromptTokens !== lastPromptBefore) throw new Error("一次性调用覆盖了主回合的 last usage")

        // 总量与分项同源，且没有把一次性调用漏掉
        const summed = summedBuckets()
        const grand = usageGrandTotal()
        for (const key of Object.keys(summed) as (keyof PurposeUsage)[]) {
          if (grand[key] !== summed[key]) throw new Error(`总量与分项不同源: ${key} 分项合计 ${summed[key]} ≠ 总量 ${grand[key]}`)
        }
        if (grand.input < mainBefore.input + plannerAfter.input) throw new Error("总消耗里没有包含一次性调用")
        if (grand.total <= mainBefore.total) throw new Error("一次性调用的 token 没有进入总消耗")

        // 失败的一次性调用同样产生调用次数；Provider 未回报时不能把全 0 当准确用量
        installUnreportedErrorProvider()
        const beforeError = { ...debug.usage.planner }
        // 复杂度评估在 LLM 失败时自己回退（generatePlan 不吞 Provider 错误，不适合做失败路径）
        const fallback = await evaluateComplexity("帮我分析一下", ["重构"])
        if (fallback.score !== 1 || fallback.triggeredBy !== "llm") throw new Error("一次性调用失败时没有走回退路径")
        const afterError = debug.usage.planner
        if (afterError.calls !== beforeError.calls + 1) throw new Error("失败的一次性调用没有计数")
        if (afterError.reported !== beforeError.reported) throw new Error("Provider 未回报的失败调用被当成准确 usage")
      } },
    ] },
  ],
}

export default 用量分列
