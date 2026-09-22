import { MIN_CONTEXT_WINDOW, contextBudget, estimateContextTokens, toHarnessEstimateTokens } from "@/services/context"
import { compactionSettingsFor } from "@/services/engine/pi"
import type { SceneDef } from "../../types"

// 上游 shouldCompact 比的是它的 estimateContextTokens：会话里存在有效 provider usage 时
// 前缀按真实 usage 计，只有尾随消息按 chars/4 估。本仓估算同样以真实 token 为目标口径，
// 两边可以直接相比，换算因子是 1（见 toHarnessEstimateTokens）。
//
// 真正要守的不变量是「压缩先于硬预算报错」。硬预算触发点会被估算器偏差 k
// （本仓估算 / 真实 token）提前到 hardInputLimit / k，所以 k 必须小于 hardInputLimit 与
// normalInputTarget 的比值。该比值随窗口增大逼近 1（compactionHeadroom 被 MAX_HEADROOM
// 封顶），是本场景最容易被改坏的一处。
export const 压缩阈值口径: SceneDef = {
  meta: {
    caseId: "memory-compaction-threshold-calibration",
    module: "memory",
    contractId: "mm-21",
    description: "压缩阈值口径：阈值落在本仓正常输入目标上并先于硬预算触发，估算器偏差不越过硬预算余量",
    depth: "shallow",
    suite: "regression",
    entry: "unit",
    tags: ["memory", "compaction", "budget"],
  },
  turns: [{
    index: 1,
    description: "核对阈值、保留窗口与估算器偏差",
    userText: "核对压缩阈值口径。",
    checks: [{ type: "expectCompactionThresholdCalibration", run: async () => {
      // 各类正文的真实 token 密度取实测值，不复制本仓常数：拉丁散文约 4 字符 1 token，
      // 中文约 1 字符 1 token。偏差 = 本仓估算 / 真实 token，1 表示对齐。
      const probeChars = 1_000
      const biases = [
        { label: "纯 ASCII", bias: estimateContextTokens("a".repeat(probeChars)) / (probeChars / 4) },
        { label: "纯中文", bias: estimateContextTokens("字".repeat(probeChars)) / probeChars },
      ]

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
        // 同口径直接比较：压缩阈值必须先于宿主硬预算触发。
        if (threshold >= budget.hardInputLimit) {
          throw new Error(`${window} 窗口的压缩阈值晚于宿主硬预算: ${threshold} >= ${budget.hardInputLimit}`)
        }
        // 保留窗口必须放得进消息可用空间，切点才有机会存在。
        if (settings.keepRecentTokens >= budget.hardInputLimit) {
          throw new Error(`${window} 窗口的保留窗口超过消息可用空间: ${settings.keepRecentTokens} >= ${budget.hardInputLimit}`)
        }
        // 估算器偏差一旦吃掉硬预算与正常输入目标的差额，硬预算就会先于压缩报错。
        const headroomRatio = budget.hardInputLimit / budget.normalInputTarget
        for (const { label, bias } of biases) {
          if (bias >= headroomRatio) {
            throw new Error(`${window} 窗口下${label}的估算偏差 ${bias} 达到硬预算余量上限 ${headroomRatio}，硬预算会先于压缩报错`)
          }
        }
      }

      if (toHarnessEstimateTokens(0) < 1) throw new Error("空预算的换算没有下限保护")
    } }],
  }],
}

export default 压缩阈值口径
