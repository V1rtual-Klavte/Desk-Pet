// 过程状态 UI 事件的唯一发送面与顶栏 owner：阶段提示、工具过程文案、代际清扫、首条揭示释放，
// 以及 best-effort UI 事件发布（流式增量、工具状态）。由原回合运行模块抽出（T1.5）。

import type { PiAgentTurnOutput } from "@/services/engine/state"
import { formatError } from "@/services/error"
import { HOST_EVENT_STAGE_HINT, publishUiEvent } from "@/services/host"
import type { HostEventMap, NodeUiEventName } from "@/services/host"
import { setFirstRevealHandler } from "@/services/humanizer"
import { createLogger } from "@/services/logger"
import { getSimpleStage, getStagePrompt } from "@/services/personality/stages-cache"
import type { SimpleStageKey } from "@/services/personality/stages-cache"
import { getActiveSessionId } from "@/services/session/store"
import { listTitlebarOwners, releaseTitlebarStatus, setTitlebarStatus } from "@/services/titlebar"

// 日志分类沿用拆分前的 `PiRuntime`：纯搬移，不改日志口径。
const log = createLogger("PiRuntime")

/**
 * 阶段状态行事件的唯一发送点（thinking / planning / retry）。
 *
 * 只发语义 key，文案由界面按当前 Card 取 —— 与 tool-executing 同一条口径，
 * 引擎不持有第二份台词，加一个阶段也不需要改事件协议。
 */
export function processTitlebarOwner(sessionId: string, generation: number): string {
  return `agent-process:${sessionId}:${generation}`
}

/**
 * 释放同会话中代际早于 `generation` 的过程 owner（遗弃回合的自愈出口）。
 *
 * 被崩溃中断/被遗弃的回合可能永远走不到收尾：driveTurn 的 finally 不执行（挂起的
 * await 链），或延后释放等不到首次揭示 —— 顶栏「正在输入」会永久滞留，且断言只读
 * 文本，跨场景残留会顶住后续同文案状态（2026-10-09 全量 e2e 的 humanizer 场景即以
 * 此暴露：两个中断场景的回合各留一个 owner）。不依赖回合收尾的兜底就是这条：新回合
 * 开始时把旧代际清一遍；owner 键仍带代际，旧回合的迟到释放不会误删新回合的状态。
 */
export function releaseStaleProcessTitlebarOwners(sessionId: string, generation: number): void {
  const prefix = `agent-process:${sessionId}:`
  for (const owner of listTitlebarOwners()) {
    if (!owner.startsWith(prefix)) continue
    const staleGeneration = Number(owner.slice(prefix.length))
    if (Number.isInteger(staleGeneration) && staleGeneration < generation) releaseTitlebarStatus(owner)
  }
}

/**
 * 拟人化回合把顶栏 typing 所有权交给揭示调度器（首泡揭示时释放）的唯一判据。
 *
 * 必须与 runner 的入队条件严格同集（`runner.ts` 的 `pushTurnOutcome`）：runner 只对
 * 「未停止、有正文、无工具轮」的拟人回合调用 `enqueueCommitted`。判据一旦放宽（例如
 * 漏掉工具轮或已停止的回合），被延后的 owner 永远等不到 firstReveal，顶栏 typing 文案
 * 会永久滞留 —— 2026-10-09 全量 e2e 的 humanizer 场景正是以「泄漏 owner 顶住文本」的
 * 形态暴露了这处不一致（带工具轮的拟人回合 defer 了却从不入队）。
 */
export function defersTitlebarReleaseToReveal(
  output: Pick<PiAgentTurnOutput, "humanized" | "silent" | "reply" | "abortedByStop" | "toolCallHistory">,
): boolean {
  // 工具轮不再是 task 流：只要本轮走的是 casual 拟人表达，就交给延迟揭示队列。
  // 计划/任务步骤的 humanized=false，不会走到这里。
  return output.humanized === true && output.silent !== true && Boolean(output.reply)
    && output.abortedByStop !== true
}

// The scheduler runs after the committed message reaches the runner; its first visible bubble ends
// the typing titlebar owner even though the lane itself may already have settled.
setFirstRevealHandler(state => releaseTitlebarStatus(processTitlebarOwner(state.sessionId, state.runGeneration)))

export function emitStageHint(sessionId: string | undefined, stage: SimpleStageKey, generation?: number): void {
  if (!sessionId || getActiveSessionId() !== sessionId) return
  void emitUiEvent(HOST_EVENT_STAGE_HINT, { sessionId, stage })
  if (generation === undefined) return
  const owner = processTitlebarOwner(sessionId, generation)
  const text = getSimpleStage(stage)
  // System process status outranks passive presence (priority 10) and stays Card-authored.
  if (text) setTitlebarStatus(owner, text, 20)
  else releaseTitlebarStatus(owner)
}

/**
 * 工具阶段（executing / done / blocked）的过程文案 → 顶栏，与阶段提示共用同一 owner
 * 和释放点（首条揭示 / 回合结束）。
 *
 * 用户规则（2026-10-05）：过程状态**只在顶栏显示**，聊天窗底部不再占用状态文案 ——
 * 这里补的正是原先只在聊天窗状态行出现的那半（工具过程文案）。
 */
export function emitToolStageTitlebar(
  sessionId: string | undefined,
  generation: number | undefined,
  key: "executing" | "done" | "blocked",
): void {
  if (!sessionId || generation === undefined || getActiveSessionId() !== sessionId) return
  const owner = processTitlebarOwner(sessionId, generation)
  const text = getStagePrompt(key, "")
  if (text) setTitlebarStatus(owner, text, 20)
  else releaseTitlebarStatus(owner)
}

/**
 * UI 事件（工具状态、流式增量等）统一 best-effort：经 UI 事件端口发布（桥的
 * publishEvent）。失败不影响回合，但保留 best-effort 语义的同时
 * 必须留下事件名 —— 界面少刷新一次与「这条事件从没发出」在日志里要能分清（§4.1 就地留痕）。
 */
export async function emitUiEvent<K extends NodeUiEventName>(event: K, payload: HostEventMap[K]): Promise<void> {
  try { await publishUiEvent(event, payload) } catch (error) { log.warn("UI 事件发送失败（best-effort）:", event, formatError(error)) }
}
