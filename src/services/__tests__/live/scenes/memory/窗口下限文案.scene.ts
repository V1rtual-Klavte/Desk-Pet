import { contextWindowError, MIN_CONTEXT_WINDOW } from "@/services/context"
import { aiConfig } from "@/services/config"
import { installFakeProvider } from "../../fake-provider"
import { resolvePiTurnModel } from "@/services/engine/pi"
import { formatError } from "@/services/error"
import type { SceneDef } from "../../types"

/** 原设置页文案里的那句话：两个调用点共用下限，但归因不能共用。 */
const CONFIG_FLAVOR = "上下文窗口配置最低"
const MODEL_FLAVOR = "改用窗口更大的模型"

// 同一条下限有两个归因：设置页报的是「你填的值太低」（可改配置），模型解析报的是
// 「模型目录的已知窗口太小」（改配置没用）。归因错了，用户会去改一个本来合法的值。
export const 窗口下限文案: SceneDef = {
  meta: {
    caseId: "memory-context-window-message",
    module: "memory",
    contractId: "mm-30",
    description: "模型解析处报出的窗口下限错误区分「模型目录窗口与配置取小」：指出模型 id 与配置值并建议换模型；设置页校验文案不变",
    depth: "shallow",
    suite: "regression",
    entry: "unit",
    tags: ["memory", "error"],
  },
  turns: [{
    index: 1,
    description: "校验两种归因的文案、边界与模型解析处的真实接线",
    userText: "校验窗口下限错误的归因文案。",
    checks: [{
      type: "expectContextWindowMessageAttribution",
      run: async () => {
        const below = MIN_CONTEXT_WINDOW - 1

        // 1. 设置页口径（不传 options）：文案逐字保持原样，保存校验依赖它。
        const configFlavor = contextWindowError(below)
        if (!configFlavor?.includes(`${CONFIG_FLAVOR} ${MIN_CONTEXT_WINDOW} tokens（当前 ${below}）`)) {
          throw new Error(`设置页口径的文案变了: ${configFlavor ?? "（合法，没报错）"}`)
        }

        // 2. 模型解析口径：指出模型 id 与配置值，并给出可修方向（换模型）。
        const modelFlavor = contextWindowError(below, { configured: 131_072, modelId: "gpt-4" })
        if (!modelFlavor) throw new Error("带 options 时应当报错")
        for (const expected of ["gpt-4", "131072", MODEL_FLAVOR]) {
          if (!modelFlavor.includes(expected)) throw new Error(`模型口径的文案缺少「${expected}」: ${modelFlavor}`)
        }
        if (modelFlavor.includes(CONFIG_FLAVOR)) {
          throw new Error(`模型口径的文案仍在指控配置: ${modelFlavor}`)
        }

        // 3. 边界：下限自身合法。
        if (contextWindowError(MIN_CONTEXT_WINDOW) !== undefined) throw new Error("下限自身应当合法")

        // 4. 接线：模型解析处必须把模型 id 与配置值交给同一处文案。
        //    用注入模型把「目录已知窗口」压到下限之下，不依赖本机模型目录里恰有小窗口模型；
        //    文案里出现模型 id 与配置值，只可能来自 model-gateway 的调用点传了 options。
        const fake = installFakeProvider([], { id: "window-floor-probe", name: "Window Floor Probe", contextWindow: below })
        let failure = ""
        try { resolvePiTurnModel() } catch (error) { failure = formatError(error) }
        finally { fake.restore() }
        if (!failure.includes(MODEL_FLAVOR)) {
          throw new Error(`模型解析处的下限错误没有给出可修方向: ${failure || "（没有抛错）"}`)
        }
        if (!failure.includes("window-floor-probe")) {
          throw new Error(`模型解析处的下限错误没有指出模型 id: ${failure}`)
        }
        // 配置值只在与生效值不同时出现（取小取到了模型目录这一侧才有的说）。
        if (aiConfig.contextMaxTokens > below && !failure.includes(String(aiConfig.contextMaxTokens))) {
          throw new Error(`模型解析处的下限错误没有指出配置值: ${failure}`)
        }
      },
    }],
  }],
}

export default 窗口下限文案
