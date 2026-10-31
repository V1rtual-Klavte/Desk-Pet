// 回合消费点：流式正文按消息落 UI，usage 按请求进统计（子运行 visible=false 不外推）。
// 由原回合运行模块抽出（T1.5），不改变行为。

import { createMessageId } from "@/services/agent/types"
import { estimateContextTokens, estimateMessageTokens, ESTIMATE_DRIFT_WARN_RATIO } from "@/services/context"
import { recordModelUsage, updateRequestStats } from "@/services/debug"
import { publishRuntimeTrace } from "@/services/engine/protocol"
import type { HarnessRunSinks } from "@/services/engine/state"
import { formatError } from "@/services/error"
import { HOST_EVENT_ASSISTANT_STREAM, HOST_EVENT_ASSISTANT_STREAM_END, HOST_EVENT_TOOL_COMPLETED } from "@/services/host"
import { createLogger } from "@/services/logger"
import { getActiveSessionId, pushMessageFor } from "@/services/session/store"
import { fromPiMessage } from "./message-adapters"
import { RuntimeDataStreamFilter } from "./stream-text"
import { emitStageHint, emitToolStageTitlebar, emitUiEvent } from "./titlebar"
import type { TurnKernel } from "./turn-kernel"

// 日志分类沿用拆分前的 `PiRuntime`：纯搬移，不改日志口径。
const log = createLogger("PiRuntime")

/**
 * 回合消费点：流式正文按消息落 UI，usage 按请求进统计。
 *
 * `visible=false` 是**子运行**（规划 / 计划步骤 / 子代理）的口径：过程消息、工具结果与
 * 流式草稿都不进活跃会话的可见列表与瞬时尾巴 —— 子运行槽是内存临时的、什么都不落盘，
 * 推出去的气泡会在下一次读模型重载时整体消失（2026-10-06 真机「几条 AI 消息闪一下就没」）。
 * 阶段提示与工具过程文案照常发：过程可见性的显示位是顶栏（用户 2026-10-05 定的口径）。
 */
export function createTurnSinks(kernel: TurnKernel, visible: boolean): HarnessRunSinks {
  let apiRound = 0
  let typingHintSent = false
  const sessionId = kernel.sessionId
  // 瞬时流式展示：只发正文增量（§6）。RUNTIME_DATA 起止与非活动会话在这里被过滤。
  let streamFilter: RuntimeDataStreamFilter | undefined
  const publishStreamDelta = (delta: string): void => {
    if (!visible || !delta || !sessionId || getActiveSessionId() !== sessionId) return
    void emitUiEvent(HOST_EVENT_ASSISTANT_STREAM, { sessionId, delta })
  }
  // 与 stripReply 的 flow 同口径：工具调用不是 task 信号，只有计划/任务步骤才是。
  const taskFlow = (): boolean => Boolean(kernel.taskReply)
  const suppressCasualStream = (): boolean => kernel.humanizerEnabled === true && !taskFlow()
  return {
    onTurnStart: () => {
      apiRound++
      kernel.generationStartedAt ??= Date.now()
      // Casual 从请求开始就显示typing，不能等到首token才把生成期暴露给界面。
      if (suppressCasualStream()) {
        typingHintSent = true
        emitStageHint(sessionId, "typing", kernel.generation)
      } else emitStageHint(sessionId, "thinking", kernel.generation)
    },
    onRetry: () => emitStageHint(sessionId, "retry", kernel.generation),
    onAssistantDelta: delta => {
      if (suppressCasualStream()) {
        if (!typingHintSent) {
          typingHintSent = true
          emitStageHint(sessionId, "typing", kernel.generation)
        }
        return
      }
      streamFilter ??= new RuntimeDataStreamFilter()
      publishStreamDelta(streamFilter.push(delta))
    },
    onAssistantStreamEnd: () => {
      // 子运行从不发增量，这里也不发 stream-end：否则会把**主回合**正在流的尾巴清掉。
      if (!visible) return
      if (suppressCasualStream()) {
        streamFilter = undefined
        if (sessionId) void emitUiEvent(HOST_EVENT_ASSISTANT_STREAM_END, { sessionId })
        return
      }
      // 未构成标签的尾部按普通正文归还；随后清空瞬时缓冲，真实消息由提交路径推送。
      const tail = streamFilter?.flush() ?? ""
      streamFilter = undefined
      publishStreamDelta(tail)
      if (sessionId) void emitUiEvent(HOST_EVENT_ASSISTANT_STREAM_END, { sessionId })
    },
    onAssistantMessage: message => {
      // 子运行不落盘也不可见：过程消息不推进活跃会话的可见列表（见函数头）。
      if (!visible) return
      const appMessage = fromPiMessage(message, `${kernel.traceContext.runId}:${apiRound}:assistant:${createMessageId()}`)
      // 带 toolCall 的过程消息与工具结果进 UI；纯文本回复由入口统一推送。
      if (appMessage && sessionId && getActiveSessionId() === sessionId && (appMessage.role === "tool" || appMessage.toolCalls?.length)) {
        pushMessageFor(sessionId, appMessage)
      }
    },
    onToolResultMessage: message => {
      if (!visible) return
      const appMessage = fromPiMessage(message, `${kernel.traceContext.runId}:${apiRound}:tool:${message.toolCallId}`)
      if (appMessage && sessionId && getActiveSessionId() === sessionId) pushMessageFor(sessionId, appMessage)
    },
    onToolEnd: (toolName, isError) => {
      emitUiEvent(HOST_EVENT_TOOL_COMPLETED, { toolId: toolName, toolName, success: !isError })
      emitToolStageTitlebar(sessionId, kernel.generation, isError ? "blocked" : "done")
    },
    onUsage: async row => {
      const previous = kernel.state.usage
      kernel.state.usage = {
        inputTokens: (previous?.inputTokens ?? 0) + row.usage.input,
        outputTokens: (previous?.outputTokens ?? 0) + row.usage.output,
        ...((previous?.cacheRead !== undefined || row.usage.cacheRead !== undefined)
          ? { cacheRead: (previous?.cacheRead ?? 0) + (row.usage.cacheRead ?? 0) } : {}),
        ...((previous?.cacheWrite !== undefined || row.usage.cacheWrite !== undefined)
          ? { cacheWrite: (previous?.cacheWrite ?? 0) + (row.usage.cacheWrite ?? 0) } : {}),
      }
      // 本次请求实际下发的工具面以 payload 采集为准（激活面收窄与回合内渐进披露都会改变它）；
      // 没有 payload 读数时才退回冻结工具面。
      const requestToolNames = kernel.requestToolNames ?? kernel.tools.map(tool => tool.name)
      // 「最近一次请求」展示统计只认对话请求：主动表达回合（`transientUserInput`，
      // 协议上 `tools=[]`，payload 里没有工具面）不刷新这组字段 —— 否则一条主动消息
      // 会把「工具 无 / 上下文 / 上次 token」全部刷成用户对话之外的样子，用户看到的
      // 「本次请求未携带工具」分不清是哪一次（用户报告）。
      // 累计用量不受影响：下方 recordModelUsage 照记 —— 主动消息确实花了 token，
      // 只是不属于面板里「我的对话请求」这一格。
      if (!kernel.transientUserInput) {
        updateRequestStats({
          // input 只是「缓存未命中」部分（pi-ai 归一口径），真实 prompt 总量要靠 cache 两项补齐
          // —— 只报 input 会把带缓存命中的请求低估一个数量级（debug.ts 里有详细口径说明）。
          promptTokens: row.usage.input,
          cacheReadTokens: row.usage.cacheRead,
          cacheWriteTokens: row.usage.cacheWrite,
          completionTokens: row.usage.output,
          systemTokens: estimateContextTokens(kernel.systemPrompt),
          conversationTokens: kernel.latestMessages.reduce((n, message) => n + estimateMessageTokens(message), 0),
          toolCount: requestToolNames.length,
          toolNames: requestToolNames,
        })
      }
      // 主回合逐请求用量记进分列统计；压缩等一次性调用不走这个 sink，
      // 由 completePiText 按自己的 purpose 单独记录。
      recordModelUsage("main", row.usage)
      // 先采集带 usage 的快照：估算偏差在这条返回里给出。
      const drift = await kernel.captureSnapshot("provider_usage", kernel.latestMessages, [], row.usage)
        .catch(error => { log.error("responded 证据写入失败:", formatError(error)); return undefined })
      publishRuntimeTrace(kernel.traceContext, "provider_usage", () => ({
        inputTokens: row.usage.input,
        outputTokens: row.usage.output,
        cacheRead: row.usage.cacheRead,
        cacheWrite: row.usage.cacheWrite,
        // **只在偏差超阈值时带出**（mm-26）：正常轮次缺省，读 trace 的人不必在一堆
        // 正常读数里筛异常。完整读数（estimated/actual/ratio）始终在 provider_usage
        // 快照里，异常排查不靠 trace 承担 —— 两边不是同一份投影。
        ...(drift === undefined || drift.ratio <= ESTIMATE_DRIFT_WARN_RATIO ? {} : { driftRatio: drift.ratio }),
      }))
    },
  }
}
