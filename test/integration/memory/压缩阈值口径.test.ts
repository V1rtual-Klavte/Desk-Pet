// ==========================================
// 压缩阈值口径 —— 从 test/e2e/scenes/memory/压缩阈值口径.scene.ts 迁到 L3
// ==========================================
//
// 上游 shouldCompact 比的是它的 estimateContextTokens：会话里存在有效 provider usage 时
// 前缀按真实 usage 计，只有尾随消息按 chars/4 估。本仓估算同样以真实 token 为目标口径，
// 两边可以直接相比，换算因子是 1（见 toHarnessEstimateTokens）。
//
// 真正要守的不变量是「压缩先于硬预算报错」。硬预算触发点会被估算器偏差 k
// （本仓估算 / 真实 token）提前到 hardInputLimit / k，所以 k 必须小于 hardInputLimit 与
// normalInputTarget 的比值。该比值随窗口增大逼近 1（compactionHeadroom 被 MAX_HEADROOM
// 封顶），是这里最容易被改坏的一处。
//
// 第二条不变量管的是**跨尺子**的保留窗口：上游 findCutPoint 对每条消息按 chars/4 计
// （不认 provider usage），所以「保留 keepRecentTokens 个单位」在纯中文下实际保住
// ≈ keepRecentTokens × 4 字符 ≈ 4×keepRecentTokens 本仓 token。它必须放得进
// normalInputTarget，否则压缩切出的保留段自身顶破正常输入目标：素材恒为空（估算总量越不过
// 保留窗口）、溢出恢复压完重试仍超限 —— 中文会话到窗口上限后无法再压缩。
//
// 归 L3 的理由：阈值换算的唯一出口 `compactionSettingsFor` 住在 `@/services/engine/harness`。
import { describe, expect, it } from "vitest"

import { MIN_CONTEXT_WINDOW, contextBudget, estimateContextTokens, toHarnessEstimateTokens } from "@/services/context"
import { compactionSettingsFor } from "@/services/engine/harness"

describe("压缩阈值口径", () => {
  it("阈值落在本仓正常输入目标上并先于硬预算触发，保留窗口按估算器最坏偏差封顶 [memory-compaction-threshold-calibration]", () => {
    // 各类正文的真实 token 密度取实测值，不复制本仓常数：拉丁散文约 4 字符 1 token，
    // 中文约 1 字符 1 token。偏差 = 本仓估算 / 真实 token，1 表示对齐。
    const probeChars = 1_000
    const biases = [
      { label: "纯 ASCII", bias: estimateContextTokens("a".repeat(probeChars)) / (probeChars / 4) },
      { label: "纯中文", bias: estimateContextTokens("字".repeat(probeChars)) / probeChars },
    ]
    // 上游切点的尺子：chars/4（与真实 token 密度无关）。纯中文下本仓计数是它的 4 倍。
    const upstreamBias = Math.max(
      estimateContextTokens("a".repeat(probeChars)) / (probeChars / 4),
      estimateContextTokens("字".repeat(probeChars)) / (probeChars / 4),
    )
    expect(upstreamBias, "上游计数与 chars/4 的比例不为 1").toBeGreaterThan(0)

    for (const window of [MIN_CONTEXT_WINDOW, 131_072, 200_000]) {
      const budget = contextBudget(window)
      const settings = compactionSettingsFor(window)
      const threshold = window - settings.reserveTokens

      // 换算是一个「取小」：换算后的保留窗口不得大于预算值（不许放大），
      // 且必须留给换算本身——见下面的最坏偏差不变量。
      expect(settings.keepRecentTokens, `${window} 窗口的保留窗口没有换算到上游口径`)
        .toBeLessThanOrEqual(toHarnessEstimateTokens(budget.keepRecentTokens))
      // 最坏内容（纯非 ASCII）下保留段自身必须放得进正常输入目标：压缩之后请求必然缩小。
      expect(upstreamBias * settings.keepRecentTokens, `${window} 窗口下纯中文时保留段自身会顶破正常输入目标`)
        .toBeLessThanOrEqual(budget.normalInputTarget)
      expect(threshold, `${window} 窗口的阈值没有落在本仓正常输入目标上: ${threshold}`)
        .toBe(toHarnessEstimateTokens(budget.normalInputTarget))
      // 同口径直接比较：压缩阈值必须先于宿主硬预算触发。
      expect(threshold, `${window} 窗口的压缩阈值晚于宿主硬预算: ${threshold} >= ${budget.hardInputLimit}`)
        .toBeLessThan(budget.hardInputLimit)
      // 保留窗口必须放得进消息可用空间，切点才有机会存在。
      expect(settings.keepRecentTokens, `${window} 窗口的保留窗口超过消息可用空间: ${settings.keepRecentTokens} >= ${budget.hardInputLimit}`)
        .toBeLessThan(budget.hardInputLimit)
      // 估算器偏差一旦吃掉硬预算与正常输入目标的差额，硬预算就会先于压缩报错。
      const headroomRatio = budget.hardInputLimit / budget.normalInputTarget
      for (const { label, bias } of biases) {
        expect(bias, `${window} 窗口下${label}的估算偏差 ${bias} 达到硬预算余量上限 ${headroomRatio}，硬预算会先于压缩报错`)
          .toBeLessThan(headroomRatio)
      }
    }

    expect(toHarnessEstimateTokens(0), "空预算的换算没有下限保护").toBeGreaterThanOrEqual(1)
  })
})
