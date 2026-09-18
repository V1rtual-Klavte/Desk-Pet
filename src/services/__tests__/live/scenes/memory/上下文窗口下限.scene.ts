import { MIN_CONTEXT_WINDOW, contextWindowError } from "@/services/context"
import { aiConfig, setOverride } from "@/services/config"
import { resolvePiTurnModel } from "@/services/engine/pi"
import { formatError } from "@/services/error"
import { installFakeProvider } from "../../fake-provider"
import type { SceneDef } from "../../types"

// 低于下限的窗口没有可用的压缩切点：设置页保存被拒（复用同一个 contextWindowError），
// 运行期在模型解析这一唯一入口报错 —— 这里验证运行期路径，避免"保存能过、回合静默跑坏"。
export const 上下文窗口下限: SceneDef = {
  meta: {
    caseId: "memory-context-window-floor",
    module: "memory",
    contractId: "mm-20",
    description: "上下文窗口下限：低于 65536 的配置在模型解析处报错，合法窗口照常解析",
    depth: "shallow",
    suite: "regression",
    entry: "unit",
    tags: ["memory", "budget", "boundary", "error"],
  },
  setup: async () => {
    // 注入 fake provider，让解析出的窗口只由配置决定（min(配置, 注入模型)），不依赖模型目录。
    installFakeProvider([])
  },
  turns: [{
    index: 1,
    description: "校验窗口下限的合法路径与报错路径",
    userText: "校验上下文窗口下限。",
    checks: [{ type: "expectContextWindowFloor", run: async () => {
      if (contextWindowError(MIN_CONTEXT_WINDOW) !== undefined) throw new Error("下限自身应当合法")
      const below = MIN_CONTEXT_WINDOW - 1
      const message = contextWindowError(below)
      if (!message?.includes(String(MIN_CONTEXT_WINDOW))) throw new Error(`下限之下的文案缺少下限值: ${String(message)}`)

      const resolved = resolvePiTurnModel()
      if (resolved.contextWindow < MIN_CONTEXT_WINDOW) throw new Error(`合法配置解析出的窗口低于下限: ${resolved.contextWindow}`)
      if (resolved.contextWindow > aiConfig.contextMaxTokens) throw new Error(`解析出的窗口超过配置值: ${resolved.contextWindow}`)

      const previous = aiConfig.contextMaxTokens
      try {
        setOverride("ai.contextMaxTokens", below)
        let failure = ""
        try { resolvePiTurnModel() } catch (error) { failure = formatError(error) }
        if (!failure.includes(String(MIN_CONTEXT_WINDOW))) throw new Error(`低于下限的窗口没有在模型解析处报错: ${failure || "（没有抛错）"}`)
      } finally {
        setOverride("ai.contextMaxTokens", previous)
      }
    } }],
  }],
}

export default 上下文窗口下限
