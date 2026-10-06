// ==========================================
// 「最近一次对话请求」的真实输入量 —— 面板上下文占用（重启恢复）的证据读取
// ==========================================
//
// 用户报告（2026-10-06）：重启后面板显示「上下文 0%」，看起来像当前会话的上下文是空的。
// 实时口径（`debug.ts` 的 `updateRequestStats`）只由对话请求刷新，进程内存一清就归零；
// 真实读数其实已经持久在会话 JSONL 里：每次 Provider 回执落一档 `provider_usage` 快照
// （`runtime.ts` 的 onUsage → `captureSnapshot`），其中的 `actualInputTokens` 就是这次
// 请求的真实输入量（input + cacheRead + cacheWrite，与 `context/budget.ts` 的
// `totalInputTokens` 同源）。
//
// 本模块只做一件只读的事：取回「最近一次对话请求」的真实输入量。选取纪律与实时口径
// 逐条对齐（两条链路回答的是同一个问题）——实时口径的写入点是 `runtime.ts` 的 `onUsage`
// 收口，只认「主聊天回合（runPiAgentTurn）+ 非主动表达」。会话文件里同形落盘的
// provider_usage 快照有四类，逐类排除：
//   · 一次性文本调用（压缩/阶段/记忆/人设等，`completePiText`）：`request.purpose`
//     是 "one_shot"/"compaction"（model-gateway.ts 的 oneShot 构造）；
//   · 计划步骤子运行（`runPiSubAgent`，带 audit 时落进父会话）：requestId 前缀
//     `sub-agent-`（该前缀的唯一生产者在 `runtime.ts` 的 runPiSubAgent；子运行不走
//     主回合的 onUsage，实时口径从不显示它们的读数）；
//   · 主动表达回合：agentMessages 全部是 origin "active"（captureSnapshot 按
//     `transientUserInput` 逐条标 origin），与 onUsage 里 `!kernel.transientUserInput`
//     的排除同义 —— 否则一条主动消息会把面板刷成用户对话之外的样子（用户报告过的困惑）；
//   · 其余（对话请求本体）：`request.purpose === "turn"` 且无 active origin。
//   · 全部候选里取**最新一条且 actualInputTokens > 0**（与 debug.ts 的「0 不覆盖好值」
//     同义：Provider 未回报的行不拿 0 冒充上一次的真实读数）。
// 返回 `undefined` = 读不到真实读数（本会话没有过对话请求，或全部未回报）——调用方
// 如实显示「未知」，不得回落成 0（0 会谎报「上下文是空的」）。

import { TODO_CONTEXT } from "@earendil-works/pi-agent-core"
import { acquirePiSession } from "@/services/session/repo"
import { PROMPT_SNAPSHOT_ENTRY } from "@/services/engine/runtime"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"

const log = createLogger("RequestStats")

/**
 * 最近一次**对话请求**（不含主动表达回合）的真实输入量；读不到返回 undefined。
 *
 * 沿会话条目倒序扫描（`findEntries` 的内存态过滤，句柄在激活会话后已常开）：
 * 记住最近一次有真实读数的 provider_usage 快照即可，不重算任何统计。
 */
export async function readLastConversationPromptTokens(sessionId: string): Promise<number | undefined> {
  try {
    const session = await acquirePiSession(sessionId)
    const entries = await session.findEntries(
      { type: "custom", customType: PROMPT_SNAPSHOT_ENTRY, order: "desc" },
      TODO_CONTEXT,
    )
    for (const entry of entries) {
      if (entry.type !== "custom" || entry.customType !== PROMPT_SNAPSHOT_ENTRY) continue
      const data = entry.data as {
        captureStage?: unknown
        actualInputTokens?: unknown
        agentMessages?: unknown
        requestId?: unknown
        request?: { purpose?: unknown } | undefined
      } | undefined
      if (!data || data.captureStage !== "provider_usage") continue
      // 只认对话请求：一次性调用/压缩快照的 purpose 是 one_shot/compaction（排除）。
      if (data.request?.purpose !== "turn") continue
      // 计划步骤子运行（唯一生产者在 runPiSubAgent）不算「我的对话请求」。
      if (typeof data.requestId === "string" && data.requestId.startsWith("sub-agent-")) continue
      // 形态不符的快照（缺 agentMessages）不猜归属：跳过，不当成对话请求的读数。
      if (!Array.isArray(data.agentMessages)) continue
      const isActiveTurn = data.agentMessages.some(
        item => (item as { origin?: unknown } | null)?.origin === "active",
      )
      if (isActiveTurn) continue
      const actual = data.actualInputTokens
      if (typeof actual === "number" && actual > 0) return actual
    }
    return undefined
  } catch (error) {
    // 读失败与「确实没有读数」不同形在返回值上同形（都 undefined），但证据在 log.error：
    // 调用方一律按「未知」显示，不把失败画成 0%。
    log.error("最近一次对话请求的输入量读取失败:", { sessionId }, formatError(error))
    return undefined
  }
}
