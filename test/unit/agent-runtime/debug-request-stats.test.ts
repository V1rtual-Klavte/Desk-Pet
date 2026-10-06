// ==========================================
// 主回合逐请求统计的真实用量口径（debug.ts::updateRequestStats）—— L2
// ==========================================
//
// 归属 L2 的依据：纯进程内槽写入（无落盘、无回环、无 IPC）；输入是估算值与一份
// Provider usage 三元组，输出是 debug.ts 的四个槽位，直接断言即可。
//
// 被测行为（2026-10-05 修复「token 计算有问题」）：
//   · 真实 prompt 总量 = input + cacheRead + cacheWrite —— pi-ai 把 `input` 归一为
//     **缓存未命中**部分（openai-completions 的 parseChunkUsage），只取 input 会把
//     带缓存命中的请求低估一个数量级（实测样本：DeepSeek input=731 / cacheRead=12160）；
//   · 上下文占比以真实 prompt 为分子；Provider 未回报（全 0 行）才退回
//     system + conversation 估算；
//   · 0 不覆盖上一次的真实值（lastPromptTokens 保留）。

import { beforeEach, describe, expect, it } from "vitest"

import { debug, updateRequestStats } from "@/services/debug"

// 分母在测试里显式钉住（它是 updateRequestStats 的输入，不是被测输出）：
// 模块导入时 aiConfig 尚未初始化，靠 initDebug() 同步会引入工具注册表的无关依赖。
beforeEach(() => {
  debug.contextMaxTokens = 100_000
})

describe("主回合逐请求统计的真实用量口径", () => {
  it("真实 prompt 含缓存读写，占比以真实值为分子 [debug-request-stats-cache-inclusive]", () => {
    updateRequestStats({
      promptTokens: 1_000,
      cacheReadTokens: 8_000,
      cacheWriteTokens: 0,
      completionTokens: 50,
      // 估算 13k 与真实 9k 可区分：回归到估算口径这条立即红。
      systemTokens: 4_000,
      conversationTokens: 9_000,
      toolCount: 2,
      toolNames: ["bash", "fs.read"],
    })
    expect(debug.lastPromptTokens).toBe(9_000)
    expect(debug.lastContextUsage).toBe(9)
    expect(debug.lastToolNames).toEqual(["bash", "fs.read"])
  })

  it("Provider 未回报时退回估算且不覆盖上次真实值 [debug-request-stats-fallback-estimate]", () => {
    updateRequestStats({ promptTokens: 7_500 })
    updateRequestStats({
      promptTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      completionTokens: 0,
      systemTokens: 2_000,
      conversationTokens: 3_000,
      toolCount: 1,
      toolNames: ["bash"],
    })
    expect(debug.lastPromptTokens).toBe(7_500)
    expect(debug.lastContextUsage).toBe(5)
    expect(debug.lastToolNames).toEqual(["bash"])
  })

  it("缓存写同样计入真实 prompt [debug-request-stats-cache-write]", () => {
    updateRequestStats({
      promptTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 5_000,
      systemTokens: 0,
      conversationTokens: 0,
    })
    expect(debug.lastPromptTokens).toBe(5_100)
  })
})
