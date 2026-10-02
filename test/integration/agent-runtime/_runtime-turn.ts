// ==========================================
// runtime 入口在 L3 的等价物 —— L4 runner `executeTurn` 的 runtime 分支（scene-runner.ts）
//
// 只搬「怎么驱动一回合」，不含任何断言：把用户/助手正文按生产的消息生命周期落进会话，
// 再直连 Pi runtime 跑真实的 agent loop。`entry: "runtime"` 的场景迁到 L3 时共用这一份，
// 避免「runtime 入口长什么样」的知识在每份测试里各写一遍而漂移。
//
// 与 L4 分支逐字对齐的只有三件事：补建会话、投递前落盘正文、回合结束后把回复写回会话。
// isActiveMessage 一律 false：迁移的场景都是普通用户输入，不是主动消息入口。
// ==========================================

import type { PiAgentTurnOutput } from "@/services/engine/harness"
import { runPiAgentTurn } from "@/services/engine/harness"
import { userInputMessage } from "@/services/engine/runtime"
import { initSessions } from "@/services/session"
import { pushAssistantMessage, pushUserMessage } from "@/services/session/messages"
import { getActiveSessionId } from "@/services/session/store"

export async function runRuntimeTurn(userText: string): Promise<PiAgentTurnOutput> {
  // Runtime tests use the same durable session creation as the desktop entry（L4 runner 原注）。
  if (!getActiveSessionId()) await initSessions()
  const sessionId = getActiveSessionId()
  pushUserMessage(userText, sessionId)
  const output = await runPiAgentTurn({
    sessionId,
    userText,
    // 这条入口绕过 sendMessage，没有宿主 requestId：投递正文用同一个构造点但不带身份。
    userPrompt: userInputMessage(userText, ""),
    unansweredCount: 0,
    isActiveMessage: false,
  })
  pushAssistantMessage(output.reply, sessionId)
  return output
}
