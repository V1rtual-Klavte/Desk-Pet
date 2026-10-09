// ==========================================
// 生产入口分泡呈现（服务级）—— 取代原「真实组件分泡呈现」
// ==========================================
//
// 口径变更（测试设施去 Tauri 批）：原场景挂载生产 ChatPanel.vue、断言 WebView DOM 里的
// 逐泡可见性与组件状态位；WebView 退役、ChatPanel 随旧壳删除后，「组件自动证据」的载体
// 不存在了。处置不是删场景（会让 hz-04 永远 MISSING 或被迫放宽契约门槛），而是改为
// **服务级**：仍从真实 `sendMessage()` 进入（production entry），证据全部来自产品自身的
// 服务状态 —— 瞬态揭示调度器（@/services/humanizer）与顶栏运行时状态（@/services/titlebar）
// —— 不再触 DOM。组件渲染的实机证据（原生 UI）留待原生 UI 测试驱动承接，不在这里冒充。
//
// caseId 保留 `humanizer-real-component-reveal`：它是稳定的历史标识（契约 hz-04 与
// personality-card pc-09 都按它引用），口径变更不改写标识本身。
//
// 每条断言都问过「把产品改坏，这条会红吗」：
//   1. 生成期顶栏持有 Card typing 文案 —— 改坏 runtime 的 emitStageHint 取用
//      （getSimpleStage → setTitlebarStatus）即红；
//   2. 提交后的首个揭示状态是 held（revealed=0、partCount=2）—— 删掉/绕过
//      runner 的 enqueueCommitted、或退化成「提交即全显」即红；
//   3. 首泡揭示释放顶栏 typing 所有权 —— 断开 runtime 的 setFirstRevealHandler
//      接线即红。此处也是「defer 判据与 runner 入队条件分叉」的回归锚点：断言只读文本，
//      早先回合残留的 owner 会顶住 typing 文案（2026-10-09 全量连跑首次暴露该分叉）；
//   4. 第二泡按泡间节奏延后（首泡揭示后 1.5s 窗口内不得 revealed=2）—— 调度器
//      退化成「首泡后立刻全显」即红（首泡刻意写长：延迟 = 字数 × 220ms 且封顶
//      6000ms，窗口观测余量充足）；
//   5. 停止立即全显并回收瞬态状态 —— stopActiveRun 不再取消揭示、或状态残留即红。
//
// repeat 隔离：订阅只在断言内建立并 finally 退订；每个 trial 的 setup 都重新建会话，
// 过滤条件用「partCount === 2」（本回合的 SPLIT 两泡形态），上一 trial/暖场回合的
// 单泡状态不会混入。

import { initChat, sendMessage, stopActiveRun } from "@/services/agent"
import { setOverride } from "@/services/config"
import { getRevealState, subscribe, type HumanizerRevealState } from "@/services/humanizer"
import { getCachedStages } from "@/services/personality"
import { getActiveSessionId } from "@/services/session"
import { titlebarLogo } from "@/services/titlebar"
import { fakeText, installFakeProvider } from "../../../host/fake-provider"
import type { SceneDef } from "../../types"

/** 首个揭示状态之后、给「第二泡必须仍被挡住」的观测窗口。 */
const PART_HOLD_WINDOW_MS = 1_500
/** 首泡揭示的有界等待（lead-in 上限 1.5s，慢生成分支更短）。 */
const FIRST_REVEAL_WAIT_MS = 5_000
/** 状态轮询间隔。 */
const POLL_INTERVAL_MS = 20

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export const 生产入口分泡呈现: SceneDef = {
  meta: {
    caseId: "humanizer-real-component-reveal", module: "humanizer", contractId: "hz-04",
    description: "真实 sendMessage 提交的普通聊天多泡正文进入逐泡揭示：生成期 Card typing 经顶栏状态通道持有、首泡揭示释放；提交首发布为 held（不整条全显）、第二泡按泡间节奏延后、停止立即全显并回收瞬态状态（原 WebView 组件场景退役，改为服务级口径）",
    depth: "deep", suite: "regression", entry: "production", tags: ["boundary", "timing", "production-entry"]
  },
  setup: async () => {
    setOverride("ai.humanizer.enabled", true)
    setOverride("ai.memory.enabled", false)
    await initChat()
    // 暖场回合（runner 在 checks 之前真实发送 userText）的 provider 响应；
    // 被断言的回合由 check 自己装 gated provider 再发一条，两不相干。
    installFakeProvider([fakeText("分泡验收开始")])
  },
  turns: [{
    index: 1, description: "验证生产入口对瞬态揭示与顶栏阶段所有权的消费", userText: "开始分泡验收",
    checks: [{
      type: "expectProductionRevealProtocol", run: async () => {
        const sessionId = getActiveSessionId()
        if (!sessionId) throw new Error("前置：暖场回合没有建立活跃会话")
        const expectedTyping = getCachedStages()?.stages.typing
        if (!expectedTyping) throw new Error("测试Card没有typing台词资产")

        const seen: HumanizerRevealState[] = []
        const unsubscribe = subscribe(state => {
          // 只收本回合的两泡形态：暖场回合是单泡（partCount=1），不混进断言窗口。
          if (state.sessionId === sessionId && state.partCount === 2) seen.push({ ...state })
        })

        let release!: () => void
        let started!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        const generating = new Promise<void>(resolve => { started = resolve })
        const marker = Math.random().toString(36).slice(2, 8)
        // 首泡刻意写长：第二泡的泡间延迟取首泡字数 × 220ms（封顶 6000ms），
        // 给「第二泡仍被挡住」与「停止先于自然揭示」两段观测都留足确定窗口。
        const firstBubble = `第一泡 ${marker} 先出现；这一条刻意写长，让泡间节奏有确定而足够的观测窗口`
        const secondBubble = `第二泡 ${marker} 必须等泡间节奏，停止时立即全显`
        const provider = installFakeProvider([async () => { started(); await gate; return fakeText(`${firstBubble}\n<<SPLIT>>\n${secondBubble}`) }])

        try {
          const sending = sendMessage("这是一条没有工具的普通聊天")
          // provider 没被调用就结束（回合失败/走岔）＝前置不成立：显式失败，不挂到场景超时。
          const providerStarted = await Promise.race([
            generating.then(() => true),
            sending.then(() => false, () => false),
          ])
          if (!providerStarted) {
            await sending.catch(() => undefined)
            throw new Error("回合在 provider 开始前就结束了（前置不成立）")
          }

          // 1. 生成期：Card typing 文案由顶栏状态通道持有（组件内状态位已随组件退役）。
          // 有界等待而不是即时断言：typing 提示与 provider 调用是同一回合内两条异步路径，
          // 顺序不构成契约；只要求「生成被 gate 住的这段时间里它必须到」。
          const typingDeadline = Date.now() + 3_000
          while (titlebarLogo.text.trim() !== expectedTyping.trim() && Date.now() < typingDeadline) {
            await sleep(POLL_INTERVAL_MS)
          }
          if (titlebarLogo.text.trim() !== expectedTyping.trim()) {
            throw new Error(`生成期顶栏未显示 Card typing 文案：${titlebarLogo.text}`)
          }

          release()
          const result = await sending
          if (result.outcome !== "succeeded") throw new Error(`生产回复失败：${result.failure?.message}`)

          // 2. 提交即进入逐泡揭示：首个发布必须是 held（首泡未显、整条未全显）。
          const first = seen[0]
          if (!first) throw new Error("提交后没有发布任何揭示状态：消息没有进入逐泡揭示")
          if (first.revealed !== 0 || first.partCount !== 2) {
            throw new Error(`提交后的首个揭示状态不是 held：revealed=${first.revealed} partCount=${first.partCount}`)
          }

          // 3. 首泡揭示（有界等待）+ 顶栏 typing 所有权释放。
          const revealDeadline = Date.now() + FIRST_REVEAL_WAIT_MS
          while (!seen.some(state => state.revealed === 1) && Date.now() < revealDeadline) {
            await sleep(POLL_INTERVAL_MS)
          }
          if (!seen.some(state => state.revealed === 1)) {
            throw new Error(`${FIRST_REVEAL_WAIT_MS}ms 内首泡没有揭示（已发布 ${seen.length} 条状态）`)
          }
          if (titlebarLogo.text.trim() === expectedTyping.trim()) {
            throw new Error("首泡揭示后顶栏 typing 所有权未释放")
          }

          // 4. 第二泡被泡间节奏挡住：窗口内出现 revealed=2 即为「退化成首泡后立刻全显」。
          const heldUntil = Date.now() + PART_HOLD_WINDOW_MS
          while (Date.now() < heldUntil) {
            if (seen.some(state => state.revealed === 2)) {
              throw new Error("第二泡没有经过泡间节奏（首泡揭示后窗口内已全显）")
            }
            await sleep(POLL_INTERVAL_MS)
          }

          // 5. 停止立即全显并回收瞬态状态：stopActiveRun 先同步发布完成态再停槽。
          await stopActiveRun(sessionId)
          const last = seen[seen.length - 1]
          if (!last || last.revealed !== 2 || last.partCount !== 2 || last.typing) {
            throw new Error(`停止后揭示状态不是「立即全显、typing 已结束」：${JSON.stringify(last)}`)
          }
          if (getRevealState(sessionId, first.messageId) !== undefined) {
            throw new Error("停止后瞬态揭示状态没有回收")
          }
        } finally {
          release()
          provider.restore()
          unsubscribe()
        }
      }
    }]
  }],
}
export default 生产入口分泡呈现
