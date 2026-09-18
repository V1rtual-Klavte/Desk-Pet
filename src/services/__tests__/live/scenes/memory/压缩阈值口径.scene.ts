import { MIN_CONTEXT_WINDOW, contextBudget, estimateContextTokens, toHarnessEstimateTokens } from "@/services/context"
import { compactionSettingsFor } from "@/services/engine/pi"
import type { SceneDef } from "../../types"

// 上游 shouldCompact 比的是它自己的估算（消息 chars/4 或 provider usage），本仓预算是
// chars/2.5。阈值不换算就会晚约 1.6 倍触发，宿主硬预算先一步把请求拦成报错 —— 这里用
// 公开估算函数反推两边口径，验证「阈值与保留窗口都落在本仓预算内」且「阈值早于硬预算」。
export const 压缩阈值口径: SceneDef = {
  meta: {
    caseId: "memory-compaction-threshold-calibration",
    module: "memory",
    contractId: "mm-21",
    description: "压缩阈值口径：派生的 reserve/keepRecent 换算到上游估算口径，阈值先于宿主硬预算触发",
    depth: "shallow",
    suite: "regression",
    entry: "unit",
    tags: ["memory", "compaction", "budget"],
  },
  turns: [{
    index: 1,
    description: "核对阈值与保留窗口的口径换算",
    userText: "核对压缩阈值口径。",
    checks: [{ type: "expectCompactionThresholdCalibration", run: async () => {
      // 本仓每个字符的 token 成本：用公开估算函数量出来，不复制 CHARS_PER_TOKEN。
      const probeChars = 1_000
      const oursPerChar = estimateContextTokens("字".repeat(probeChars)) / probeChars
      // 上游 compaction.estimateTokens 的固定口径：4 字符 ≈ 1 token。
      const charsPerHarnessToken = 4

      for (const window of [MIN_CONTEXT_WINDOW, 131_072, 200_000]) {
        const budget = contextBudget(window)
        const settings = compactionSettingsFor(window)
        const threshold = window - settings.reserveTokens

        if (settings.keepRecentTokens !== toHarnessEstimateTokens(budget.keepRecentTokens)) {
          throw new Error(`${window} 窗口的保留窗口没有换算到上游口径`)
        }
        if (threshold !== toHarnessEstimateTokens(budget.normalInputTarget)) {
          throw new Error(`${window} 窗口的阈值没有落在本仓正常输入目标上: ${threshold}`)
        }
        // 阈值（上游口径，按字符折算）必须先于宿主硬预算（本仓口径，按字符折算）触发。
        const thresholdChars = threshold * charsPerHarnessToken
        const hardLimitChars = budget.hardInputLimit / oursPerChar
        if (thresholdChars >= hardLimitChars) {
          throw new Error(`${window} 窗口的压缩阈值晚于宿主硬预算: ${thresholdChars} >= ${hardLimitChars}`)
        }
        // 保留窗口（上游口径，按字符折算）必须放得进消息可用空间，切点才有机会存在。
        const keepChars = settings.keepRecentTokens * charsPerHarnessToken
        if (keepChars >= hardLimitChars) {
          throw new Error(`${window} 窗口的保留窗口超过消息可用空间: ${keepChars} >= ${hardLimitChars}`)
        }
      }

      if (toHarnessEstimateTokens(0) < 1) throw new Error("空预算的换算没有下限保护")
    } }],
  }],
}

export default 压缩阈值口径
