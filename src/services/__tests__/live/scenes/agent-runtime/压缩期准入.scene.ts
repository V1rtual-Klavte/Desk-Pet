import type { Context, FauxModelDefinition, FauxProviderState, FauxResponseStep } from "@earendil-works/pi-ai"
import { aiConfig } from "@/services/config"
import { contextBudget } from "@/services/context"
import { compactionSettingsFor, harnessSlots, isSessionBusy, listQueuedInputs } from "@/services/engine/pi"
import { initChat, sendMessage } from "@/services/agent/runner"
import { getFallbackReply } from "@/services/personality/stages-cache"
import type { FallbackReplies } from "@/services/personality/stages-file"
import { chatHistory, getActiveSessionId } from "@/services/session/store"
import { fakeText, installFakeProvider } from "../../fake-provider"
import { assistantTexts, compactionEntries, countTexts, sessionEntries, sessionMessages, userTexts } from "../../session-entries"
import type { AssertContext, SceneDef } from "../../types"

// ── 场景口径：摘要请求在飞时的新输入按准入如实拒绝，不写兜底失败回复、不静默排队 ──
//
// HN-02：准入判定不能再只看「槽是否 running」—— 手动压缩不 `begin`，压缩期间槽仍是 idle。
// 旧实现因此把压缩窗口里的输入放进正常回合：begin 成功、驱动拿到 LaneBusy，用户收到的是一条
// 兜底失败回复（`turnFailureReply` → `getFallbackReply`），「没发出去」被说成了「聊过了」。
// 同一窗口里 `/clear` 更糟：`releaseWhenIdle` 判 isRunning()===false → 删槽并关掉 Harness，
// 而压缩的 drive 还在飞。
//
// 窗口用 fake provider 的**挂起响应**造：摘要请求（before_compaction 钩子里的 `completePiText`）
// 一直等在这里不返回，lane 因此有未结算的 compaction 操作。窗口内：① 新输入拿到 outcome=failed
// 且没有兜底回复；② 拒绝没有向模型发请求、正文没进会话也没进 lane inbox；③ `/clear` 被
// busyPolicy 明确拒绝且 Harness 没被关掉；④ 放行摘要后压缩正常完成，同一会话照常发消息。
const FAKE_MODEL: FauxModelDefinition = { id: "deskpet-fake", name: "Desk-Pet Fake", contextWindow: 131_072, maxTokens: 16_384 }
/** 真正生效的窗口与 resolvePiTurnModel 一致：配置值与注入模型窗口取小。 */
const WINDOW_TOKENS = Math.min(aiConfig.contextMaxTokens, 131_072)
const BUDGET = contextBudget(WINDOW_TOKENS)
const SETTINGS = compactionSettingsFor(WINDOW_TOKENS)
/**
 * 垫在尾段的正文：上游按 chars/4 估 token，切点（从尾部按 chars/4 累加到 keepRecentTokens）
 * 要落在这一段上，第一轮才会整体进摘要范围（否则宿主摘要钩子 decline，压根没有摘要请求可挂）。
 * 1.05 倍是贴着保留窗口下界的有意余量：更紧切不出范围，更松会撞上自动压缩阈值。
 */
const PAD = "x".repeat(Math.ceil(SETTINGS.keepRecentTokens * 4 * 1.05))

const FIRST_USER = "第一轮：先在会话里留下可摘要的历史。"
const FIRST_REPLY = "第一轮完成"
const PAD_USER = `第二轮：${PAD}这是压缩切点要落进去的长正文。`
const PAD_REPLY = "第二轮完成"
const REFUSED_TEXT = "压缩期间发出的这条输入不该被当成正常回合。"
const AFTER_TEXT = "压缩结束后这条输入应该正常送达。"
const AFTER_REPLY = "压缩后的回合完成"
const REFUSED_NOTICE = "正在压缩这个会话，等它跑完再发哦～"
const REFUSAL_MESSAGE = "会话正在执行结构操作（压缩），输入未发送"
const SUMMARY_INTENT = "压缩期准入：摘要请求在飞时输入被如实拒绝"
const SUMMARY = JSON.stringify({
  intent: SUMMARY_INTENT,
  facts: ["压缩窗口内的新输入按准入拒绝"],
  corrections: [],
  pending: ["核对压缩完成后续跑是否发生"],
  continuity: ["本次使用 fake provider"],
  nextSteps: ["检查拒绝没有写兜底回复"],
})

/** `getFallbackReply` 系列文案：兜底失败回复的真相源，按运行时取值比对（Card 文案会覆盖常量）。 */
const FALLBACK_KEYS: ReadonlyArray<keyof FallbackReplies> = [
  "concurrentRejected", "maxRetriesExhausted", "turnTimeout", "toolLoopMaxRounds",
  "llmUnavailable", "subAgentDone", "subAgentFailed", "subAgentNoResult", "compactionFailed",
]

let sessionId = ""
let fakeState: FauxProviderState | undefined
/** 摘要请求的闸门：resolve 之前摘要请求一直挂着，压缩窗口就一直开着。 */
let releaseSummary: (() => void) | undefined
let summaryRequestInFlight = false
/** 压缩 promise 的结算：真值等待（不用轮询），由 then/catch 置位。 */
let compactionSettled: Promise<true> | undefined
let compactionDone = false
let compactReply = ""
let compactOutcome: string | undefined
let requestsAfterSetup = -1
/**
 * 「窗口开着」那一刻的 provider 请求数（摘要请求已计入）。
 *
 * 基线必须在这里取，而不是 `/compact` 发出之前：摘要请求**本身就是一次 provider 请求**
 * （上游 `faux.js` 的 `callCount++` 在 `stream()` 入口同步发生，早于 step 回调），
 * 拿 setup 后的计数当基线会把摘要请求自己算成「拒绝发了请求」（W5 第三轮实测 `2 → 3`）。
 */
let requestsAtWindowOpen = -1
let assistantBeforeRefusal = -1
let compactionCountAfterCompletion = -1

function lastRequestText(context: Context): string {
  const last = context.messages[context.messages.length - 1]
  return typeof last?.content === "string"
    ? last.content
    : (last?.content ?? []).map(part => (part.type === "text" ? part.text : "")).join("")
}

/** 有界等待：超时返回 undefined，由场景给出可读原因，绝不把失败拖成场景超时。 */
function bounded<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    work.finally(() => { if (timer) clearTimeout(timer) }),
    new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), ms) }),
  ])
}

/** 断言失败时的真实口径，别让人从「窗口没挂住」反推原因。 */
function sizing(): string {
  return `窗口 ${WINDOW_TOKENS}、硬上限 ${BUDGET.hardInputLimit}、保留窗口 ${SETTINGS.keepRecentTokens}；尾段正文 ${PAD.length} 字符`
}

/** 拒绝时的回合结局（生产入口把 outcome 映射成 failure 的存在性）。 */
function refusalOutcome(ctx: AssertContext): string {
  return ctx.output.failure ? "failed" : "succeeded"
}

export const 压缩期准入: SceneDef = {
  meta: {
    caseId: "runtime-compact-admission",
    module: "agent-runtime",
    contractId: "ar-15",
    description: "摘要请求在飞时的新输入按准入如实拒绝（无兜底回复、不排队、不发模型请求）；同一窗口的 /clear 被拒绝且 Harness 未被关闭，结构操作结束后会话照常可用",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["production-entry", "compaction", "boundary", "error"],
  },
  setup: async () => {
    summaryRequestInFlight = false
    compactionDone = false
    compactReply = ""
    compactOutcome = undefined
    compactionCountAfterCompletion = -1
    requestsAfterSetup = -1
    requestsAtWindowOpen = -1
    let markSummaryStarted!: () => void
    // 完成值必须是可区分的真值：`bounded` 用 undefined 表示超时，而 Promise<void> 的完成值也是
    // undefined —— 把两者混同会把「窗口已经造出来」判成「30s 没等到摘要请求」（W5 整轮的实测现场：
    // setup 在 40ms 就抛这条，而同一现场是 忙=true、/compact 未结算、provider 请求数 setup=2/now=3，
    // 也就是摘要请求已经进 provider 挂着 —— 窗口本来就是好的）。
    const summaryStarted = new Promise<boolean>(resolve => { markSummaryStarted = () => resolve(true) })
    let markCompactionSettled!: () => void
    const settled = new Promise<true>(resolve => { markCompactionSettled = () => resolve(true) })
    compactionSettled = settled
    const gate = new Promise<void>(resolve => { releaseSummary = resolve })

    /**
     * 摘要响应：脚本被别的请求取走就是错位，立即报错。
     * 它同时是「窗口真的开着」的证据 —— 请求已进入 provider，但响应要等闸门放行。
     */
    const summaryStep: FauxResponseStep = context => {
      const text = lastRequestText(context)
      if (!text.includes("\"instructions\"")) throw new Error(`摘要脚本被非摘要请求取走: ${text.slice(0, 60)}`)
      summaryRequestInFlight = true
      // 窗口开启的定位点：这一条请求已经计入 callCount（见字段注释），后续任何增长
      // 都只能来自被拒绝的输入 —— 那才是本场景要挡的事。
      requestsAtWindowOpen = fakeState?.callCount ?? -1
      markSummaryStarted()
      return (async () => {
        await gate
        summaryRequestInFlight = false
        return fakeText(SUMMARY)
      })()
    }

    fakeState = installFakeProvider(
      [fakeText(FIRST_REPLY), fakeText(PAD_REPLY), summaryStep, fakeText(AFTER_REPLY)],
      FAKE_MODEL,
    ).state
    await initChat()
    sessionId = getActiveSessionId()

    // 两轮真实回合造出「可摘要范围 + 保留尾段」：第一轮整体落进摘要范围（见 PAD 的口径注释）。
    await sendMessage(FIRST_USER)
    await sendMessage(PAD_USER)
    assistantBeforeRefusal = assistantTexts(await sessionMessages()).length
    requestsAfterSetup = fakeState.callCount

    // 手动压缩：不 await —— 它的摘要请求要一直挂着，窗口才存在。
    const compactPromise = sendMessage("/compact")
    void compactPromise.then(result => {
      compactReply = result.reply
      compactOutcome = result.outcome
      compactionDone = true
      markCompactionSettled()
    }, error => {
      compactOutcome = `rejected:${error instanceof Error ? error.message : "unknown"}`
      compactionDone = true
      markCompactionSettled()
    })
    const started = await bounded(summaryStarted, 30_000)
    // `started !== true` 才是真超时（bounded 超时返回 undefined）；这里是与 `bounded` 的约定，
    // 不是可选判断 —— 窗口没造出来时逐字给出拒绝它的那道门（见下方 detail）。
    if (started !== true || compactionDone) {
      // 诊断口径：30s 没等到摘要请求时，只有 `/compact` 的终态能指出是哪道门拒绝了它 ——
      // 准入拒绝（pending / 队列未就绪 / closed / busy）、没有可摘要范围（nothing / declined），
      // 以及「摘要请求被别的请求取走了脚本」（setup 请求数会多出来，回执里带摘要内核的失败原因）。
      // 只报「窗口造不出来」会把这些路径混成一条，本轮已因此无法定位。
      const view = listQueuedInputs(sessionId)
      const detail = [
        `窗口 ${WINDOW_TOKENS}`,
        `/compact=${compactionDone ? String(compactOutcome) : "未结算"}`,
        `回执=${JSON.stringify(compactReply)}`,
        `队列镜像 loaded=${view.loaded}/items=${view.items.length}`,
        `忙=${await isSessionBusy(sessionId)}`,
        `provider 请求数 setup后=${requestsAfterSetup}/窗口开启=${requestsAtWindowOpen}/now=${fakeState?.callCount ?? -1}`,
      ].join("，")
      throw new Error(compactionDone
        ? `压缩在摘要请求在飞之前就结算了（${detail}）｜${sizing()}`
        : `摘要请求没有在 30s 内开始，压缩窗口造不出来（${detail}）｜${sizing()}`)
    }
  },
  turns: [
    {
      index: 1,
      description: "压缩窗口内的新输入被如实拒绝，且拒绝没有留下任何正文与模型请求",
      userText: REFUSED_TEXT,
      // 准入拒绝是这条输入的正确结局：HN-03 的 "admission" 档已落地（runner.ts 压缩期
      // 拒绝站点按调用点写入 admission，不经过文案分类）。仍容 unknown：分类只圈粗桶，
      // 真正钉住「哪条失败路径」的是 message。
      expectFailure: { kind: ["unknown", "admission"], message: "输入未发送" },
      checks: [{
        type: "expectCompactWindowAdmissionRefusal",
        run: async (ctx) => {
          // 先把窗口内的断言跑完：任何一条失败都先释放闸门，避免压缩操作悬到场景之外。
          let failure: unknown
          try {
            await assertWindowRefusal(ctx)
          } catch (error) {
            failure = error
          } finally {
            releaseSummary?.()
          }
          if (failure !== undefined) throw failure

          // ④ 结构操作正常完成：压缩条目由宿主摘要钩子提交，拒绝没有把它变成第二份状态。
          const settled = compactionSettled
          if (settled === undefined) throw new Error("场景前置状态缺失：setup 没有建立压缩窗口")
          if (await bounded(settled, 30_000) === undefined) {
            throw new Error(`放行摘要后压缩没有在 30s 内结算｜${sizing()}`)
          }
          if (compactOutcome !== "succeeded") throw new Error(`压缩没有正常完成: ${String(compactOutcome)}`)
          if (!compactReply.includes("压缩完成")) throw new Error(`/compact 没有按完成回执: ${JSON.stringify(compactReply)}`)
          if (!compactReply.includes(SUMMARY_INTENT)) {
            throw new Error(`/compact 回执没有带宿主摘要意图，宿主钩子可能没跑: ${JSON.stringify(compactReply)}`)
          }
          const compactions = compactionEntries(await sessionEntries())
          compactionCountAfterCompletion = compactions.length
          if (compactions.length !== 1) throw new Error(`压缩条目数不是 1: ${compactions.length}`)
          if (!compactions[0]!.fromHook || !compactions[0]!.summary.includes(SUMMARY_INTENT)) {
            throw new Error("压缩条目不是宿主 before_compaction 内核提交的")
          }
          // 压缩的隐藏续跑不该发生（inbox 空）：助手正文不许因它多出一条。
          const assistants = assistantTexts(await sessionMessages()).length
          if (assistants !== assistantBeforeRefusal) {
            throw new Error(`压缩的隐藏续跑写了助手正文: ${assistantBeforeRefusal} → ${assistants}`)
          }
          if (await isSessionBusy(sessionId)) throw new Error("结构操作结算后会话仍被判忙")
        },
      }],
    },
    {
      index: 2,
      description: "结构操作结束后，同一会话照常发消息",
      userText: AFTER_TEXT,
      checks: [{
        type: "expectTurnAfterCompactionSucceeds",
        run: async (ctx) => {
          if (ctx.output.failure) throw new Error(`压缩后的回合失败: ${ctx.output.failure.message}`)
          if (!ctx.output.reply.includes(AFTER_REPLY)) {
            throw new Error(`压缩后的回合没有按脚本完成: ${JSON.stringify(ctx.output.reply)}`)
          }
          if (compactOutcome !== "succeeded" || compactionCountAfterCompletion !== 1) {
            throw new Error(`压缩窗口的收尾状态变了: ${String(compactOutcome)} / ${compactionCountAfterCompletion}`)
          }
          if (countTexts(userTexts(await sessionMessages()), AFTER_TEXT) !== 1) {
            throw new Error("压缩后的回合正文没有恰好出现一次")
          }
          const queued = harnessSlots.snapshot(sessionId)?.queued ?? []
          if (queued.length !== 0) throw new Error(`压缩后的回合留下排队项: ${JSON.stringify(queued)}`)
          if (await isSessionBusy(sessionId)) throw new Error("压缩后的回合结束后会话仍被判忙")
        },
      }],
    },
  ],
}

/** 窗口内的全部断言：拒绝语义、无兜底回复、不排队、不发请求，以及同窗口的 /clear。 */
async function assertWindowRefusal(ctx: AssertContext): Promise<void> {
  const state = fakeState
  if (state === undefined) throw new Error("场景前置状态缺失：fake provider 没有安装")
  // 场景前提：拒绝发生在窗口内，且窗口此刻仍然开着。
  if (ctx.output.failure === undefined) {
    throw new Error(`压缩窗口内的输入没有被拒绝: outcome=${refusalOutcome(ctx)} reply=${JSON.stringify(ctx.output.reply)}`)
  }
  if (!summaryRequestInFlight) throw new Error("摘要请求不在飞：场景前提不成立，本场景什么都没证明")

  // ① 如实拒绝：明确说明输入未发送，且没有编造回复正文。
  if (ctx.output.failure.message !== REFUSAL_MESSAGE) {
    throw new Error(`拒绝理由不是准入语义: ${ctx.output.failure.kind}: ${ctx.output.failure.message}`)
  }
  if (ctx.output.reply !== "") throw new Error(`准入拒绝不该带回复正文: ${JSON.stringify(ctx.output.reply)}`)

  // ② 「忙」判定覆盖 lane 操作：压缩窗口内必须为真（否则准入判据没覆盖到结构操作）。
  if (!await isSessionBusy(sessionId)) throw new Error("忙判定在压缩窗口内为假：准入判据没有覆盖 lane 操作")

  // ② 无兜底失败回复：拒绝没有新增任何助手条目，也没有写 getFallbackReply 系列文案。
  const messages = await sessionMessages()
  const assistants = assistantTexts(messages)
  if (assistants.length !== assistantBeforeRefusal) {
    throw new Error(`准入拒绝仍写入了助手条目: ${assistantBeforeRefusal} → ${assistants.length}`)
  }
  const fallbackFamily = FALLBACK_KEYS.map(key => getFallbackReply(key)).filter(text => text.trim().length > 0)
  const contaminated = assistants.filter(text => fallbackFamily.includes(text))
  if (contaminated.length > 0) throw new Error(`会话里出现了兜底失败回复: ${JSON.stringify(contaminated)}`)
  // 正面证据：拒绝必须被说出来，而且它不是兜底文案冒充的。
  // 读聊天视图本体（`chatHistory`）：界面拿到的就是它，「视图有没有这条说明」不因读取偏移而失真。
  const storeTexts = chatHistory.map(message => message.text)
  if (!storeTexts.includes(REFUSED_NOTICE)) {
    throw new Error(`界面没有拿到准入说明: ${JSON.stringify(storeTexts.slice(-4))}`)
  }
  if (fallbackFamily.includes(REFUSED_NOTICE)) throw new Error("准入说明与兜底文案撞了，本场景的判定依据需要复核")

  // ② 不静默排队、不偷跑模型：正文既不进会话也不进 lane inbox，全程没有新的 provider 请求。
  if (countTexts(userTexts(messages), REFUSED_TEXT) !== 0) throw new Error("被拒绝的输入进了会话正文")
  const queued = harnessSlots.snapshot(sessionId)?.queued ?? []
  if (queued.length !== 0) throw new Error(`被拒绝的输入被静默排队: ${JSON.stringify(queued)}`)
  if (requestsAtWindowOpen < 0) throw new Error("场景前置状态缺失：窗口开启时的请求数基线没有记录")
  if (state.callCount !== requestsAtWindowOpen) {
    throw new Error(`准入拒绝仍向模型发了请求: 窗口开启=${requestsAtWindowOpen} → ${state.callCount}`)
  }

  // ③ 同一窗口的 /clear：exclusive 命令必须被明确拒绝，且不能关掉还在飞的 Harness。
  const cleared = await sendMessage("/clear")
  if (!cleared.reply.includes("需要等当前回合结束再执行")) {
    throw new Error(`压缩窗口内 /clear 没有被拒绝: ${JSON.stringify(cleared.reply)}`)
  }
  if (getActiveSessionId() !== sessionId) throw new Error("/clear 在压缩窗口内被放行，会话已切换")
  const slotState = harnessSlots.peek(sessionId)?.snapshot().state ?? "missing"
  if (slotState === "closed") throw new Error("压缩窗口内的 /clear 关掉了 Harness（压缩 drive 还在飞）")
  if (countTexts(userTexts(await sessionMessages()), FIRST_USER) !== 1) {
    throw new Error("压缩窗口内 /clear 清掉了会话正文")
  }
}

export default 压缩期准入
