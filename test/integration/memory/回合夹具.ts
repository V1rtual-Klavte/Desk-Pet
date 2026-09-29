// ==========================================
// memory 的 L3 回合夹具 —— runtime / 主动消息入口的最小复现
// ==========================================
//
// 与 L4 运行器（`test/e2e/scene-runner.ts` 的 `executeTurn`）的两个入口同形：
// 建立活跃会话 → 投递正文 → 驱动真实 Pi agent loop（只把 Provider 换成 fake）→ 收尾记账。
//
// 为什么收敛成一份：迁进 L3 的四个场景（`估算器角色覆盖` / `P0快照` 的三条 / `Plan恢复`）
// 都要这一步，各抄一份的话，下一次入口形状变化（如尾随注记、请求身份）就得逐个补 ——
// L4 侧 `lastRequestText` 曾被 16 个场景各自复制，教训已经付过一次。
//
// 这里不实现任何产品行为：会话建立/投递/记账全部调用产品入口，只有 Provider 是替身。
import type { PiAgentTurnOutput } from "@/services/engine/pi"
import { runPiAgentTurn } from "@/services/engine/pi"
import { userInputMessage } from "@/services/engine/runtime"
import { sendActiveMessage } from "@/services/agent/runner"
import { initSessions } from "@/services/session"
import { pushAssistantMessage, pushUserMessage } from "@/services/session/messages"
import { getActiveSessionId } from "@/services/session/store"

/** 保证有活跃会话（与运行器一样：没有就初始化一次）。返回会话 id。 */
export async function ensureSession(): Promise<string> {
  if (!getActiveSessionId()) await initSessions()
  return getActiveSessionId()
}

/**
 * 一轮 runtime 回合：投递用户正文 → 驱动 harness lane → 推助手气泡。
 * 调用方负责在此之前装好 fake Provider（脚本顺序与断言对应）。
 */
export async function runRuntimeTurn(userText: string): Promise<PiAgentTurnOutput> {
  const sessionId = await ensureSession()
  pushUserMessage(userText, sessionId)
  const output = await runPiAgentTurn({
    sessionId,
    userText,
    // 与运行器的 runtime 入口同一构造点：投递正文带身份，不带宿主 requestId。
    userPrompt: userInputMessage(userText, ""),
    unansweredCount: 0,
    isActiveMessage: false,
  })
  pushAssistantMessage(output.reply, sessionId)
  return output
}

/**
 * 一轮主动搭话：走产品入口 `sendActiveMessage`（自定义条目 + active 来源元数据）。
 * 与运行器一致，助手气泡不由这里推 —— 主动消息的可见性由投递路径自己决定。
 */
export async function runActiveTurn(userText: string): Promise<string> {
  await ensureSession()
  return sendActiveMessage(userText)
}
