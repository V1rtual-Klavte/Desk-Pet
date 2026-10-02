import type { Context, FauxModelDefinition, FauxResponseStep } from "@earendil-works/pi-ai"
import { prepareCompaction, shouldCompact } from "@earendil-works/pi-agent-core"
import {
  L0_SHORTENED_TAG, MIN_ADDRESS_PREFIX, contextBudget, estimateContextTokens, estimateMessageTokens,
  estimateValueTokens, projectToolResultText, toolBudgetSchema, toolResultNotice, toolResultTokenBudget,
} from "@/services/context"
import { aiConfig } from "@/services/config"
import { debug } from "@/services/debug"
import { compactionSettingsFor, harnessSlots } from "@/services/engine/harness"
import { initChat } from "@/services/agent/runner"
import { getActiveSessionId } from "@/services/session"
import { SESSION_TRANSCRIPT_TOOL, TOOL_POLICY_VERSION, defineTool, register, unregister } from "@/services/tool"
import { installFakeProvider, fakeText, fakeToolCall, lastRequestText } from "../../../host/fake-provider"
import { compactionEntries, sessionEntries } from "../../../host/session-entries"
import type { SceneDef, TurnDef } from "../../../e2e/types"

// ==========================================
// 级 3 闸门：级 1/2 压完装得下 ⇒ 一次摘要 LLM 都不花（源方案 §3.2 要点 3 / C-4）
//
// 「一次 LLM 都不花」不是靠看日志，而是靠**计数请求**证明：
//   - 主观测面 `debug.usage.compaction.calls`：一次性文本调用在 model-gateway 里按 purpose
//     真实计数（`recordModelUsage("compaction", …)`），摘要请求每发出一次就 +1；
//   - 辅助观测面：`compactionEntries(...)` 恒为 0 且槽的 `contextEpoch` 不推进（零提交）；
//   - 脚本位：脚本里有一段 `summaryStep` 只接受摘要请求（被别的请求取走立刻报错），
//     省钱的那一相里它**不会**被消费 —— 被消费就等于摘要真的发出去了。
// 三条都在真实链路上：`entry: "production"` 走 `sendMessage()`，fake 只替换 Provider，
// 工具、权限、检查点、hooks 全是生产实现。
//
// 本场景证的是**闸门行为**（级 1/2 压完装得下就不花 LLM）；级 1/级 2 的投影形态
// （缩短/清空/保护区/preserve）由 `memory-projection-ladder` 覆盖，两者不重叠。
//
// ── 阶段 1（省钱）：级 1 压完装得下 ──
// 第 1 轮调用一个成功探针，返回单条就超过 `normalInputTarget` 的 ASCII 结果（1.3 倍），
// 它进请求视图时被级 1 压到头尾各 `floor(单条上限/2)` token + 一行占位提示的形态。断言链：
//   · 阈值的判据成立：工具结果刚落盘的那个检查点，`tokensBefore`（= 上一次请求的 usage +
//     尾随消息的 chars/4，上游口径）必然超阈值 —— 用上游 `prepareCompaction` 在**那一刻的
//     条目**上复算，钉住「阈值压缩路径真的被走到」，否则后面的 0 次调用只是没触发而已；
//   · C-4 的前提成立：**原文**单条就超 `normalInputTarget`（装不下），而**实测的请求视图**
//     （系统前缀 + 工具面 + 级 1 后的消息，同一个 `estimateRequestTokens` 三分量）≤ 目标；
//   · 结果：0 次摘要调用、0 条 compaction 条目、`contextEpoch` 不推进、回合照常收尾。
// **当前接线的形状**（本场景钉住的事实，不是断言）：上游在工具结果刚落盘时算出的切点会退化到
// 首条消息（`findCutPoint` 找不到落在尾随条目之后的切点），摘要范围为空 ⇒ 钩子的前置守卫
// （`messagesToSummarize` 与 `turnPrefixMessages` 都空）先于闸门块 decline；而助手回复之后再算，
// 上一次请求的 usage 已经反映过级 1 的压缩结果，阈值不再触发。两个检查点因此都不会真正执行闸门块，
// 但 C-4 的结果（一次 LLM 都不花）与前提（原文装不下、级 1 装得下）都在。闸门块自身的
// 判定核由 T3.05 的离线探针覆盖；本场景不假装它被走到。
//
// ── 阶段 2（对照：真装不下 ⇒ 摘要照常跑）──
// 同一段上游代码路径（阈值触发 ⇒ 钩子 ⇒ 装不下才走级 3），唯一变量是「视图能不能被压到目标
// 以下」：第 2 轮垫入一段**用户正文**（用户文本不进阶梯，压不动）。垫入量按第 1 轮的**实测**
// 视图现场推导，贴着「压缩后的请求视图 ≤ hardInputLimit」的上界取最大 ⇒「级 1 之后的视图」必然
// 高于 `normalInputTarget`（闸门复算必然判「装不下」，摘要照常发出），而压缩后的请求视图仍在
// 硬上限内（不会撞硬预算走溢出恢复）。上游的 `tokensBefore`（它自己的 usage 读数 + 尾随 chars/4）
// 也随之越过阈值：上游读数与本仓估算器不完全同源（非 ASCII 计费与 JSON 框架），余量留在
// `POST_VIEW_SAFETY` 里；若首跑仍不过线，失败消息里带两侧读数，调这一个旋钮即可。
// 没有这一相，阶段 1 的 0 调用无法与「摘要本来就走不到」区分。
//
// ── 载荷口径 ──
// 一律运行期：`contextBudget(window)`（**不传 maxOutput**，128k 窗口 ⇒ hardInputLimit 124354 /
// normalInputTarget 104354 / 单条上限 10435 / 摘要预算 2048）。系统前缀与工具面的 token 不写死，
// 全部由第 1 轮请求的实测值推导 —— 带宽只有 compactionHeadroom = 20000，写死一定漂移。
// 级 1 形态 = 头段 + 占位提示行 + 尾段（`projectToolResultText` 的唯一产出）：头尾各
// `floor(单条上限/2)` token，**提示行与两侧换行是额外开销**。所以「级 1 形态 ≤ 单条上限」
// 不是产品契约（单条上限只判候选资格），判据取「与本场景载荷经唯一实现重算后逐字相等」。
// ==========================================

const FAKE_MODEL: FauxModelDefinition = { id: "deskpet-fake", name: "Desk-Pet Fake", contextWindow: 131_072, maxTokens: 16_384 }
/** 真正生效的窗口与 resolvePiTurnModel 一致：配置值与注入模型窗口取小。 */
const WINDOW_TOKENS = Math.min(aiConfig.contextMaxTokens, 131_072)
const BUDGET = contextBudget(WINDOW_TOKENS)
const SETTINGS = compactionSettingsFor(WINDOW_TOKENS)
/** 单条工具结果上限（级 1 与级 2 共用）：超它的条目才进阶梯候选。 */
const L0_TOKENS = toolResultTokenBudget(WINDOW_TOKENS)

const PROBE_TOOL_ID = "ladder-gate-probe"
const PROBE_TOOL_NAME = "ladder_gate_probe"
const FIRST = `第一轮：调用 ${PROBE_TOOL_NAME} 工具，然后回复我。`

/** 探针结果：单条就超过目标视图（1.3 倍），中段标记用来证明请求视图确实被裁过。 */
const RESULT_TOKENS = Math.ceil(BUDGET.normalInputTarget * 1.3)
const CORE_MARKER = "-ladder-gate-core-marker-"
const RESULT_HALF_CHARS = Math.ceil(RESULT_TOKENS / 2) * 4
const PROBE_RESULT = `${"a".repeat(RESULT_HALF_CHARS)}${CORE_MARKER}${"b".repeat(RESULT_HALF_CHARS)}`

/** 对照相压缩后的请求视图留的余量（该视图 = 摘要 + 垫入的用户正文，必须仍在硬上限内）。 */
const POST_VIEW_SAFETY = 4_000
/** 垫入单元（25 个 ASCII 字符 = 6.25 token）：只有 ASCII 才能按 1/4 token 精确推导。 */
const PAD_UNIT = "ladder-gate-contrast-pad "
const PAD_MARKER = "对照相垫入的不可投影用户正文。"

const REPLY_1 = "第一轮回复完成。"
const REPLY_2 = "第二轮回复完成。"

const SUMMARY_MARKER = "级 3 闸门对照压缩"
const SUMMARY = JSON.stringify({
  intent: SUMMARY_MARKER,
  facts: ["级 1/2 装得下时级 3 不花摘要调用"],
  corrections: [],
  pending: ["核对对照相的 compaction 条目"],
  continuity: ["本次使用 fake provider"],
  nextSteps: ["检查 contextEpoch 是否推进"],
})

// ── 场景内状态（只在 setup 与本场景的断言里读写）──

let provider: ReturnType<typeof installFakeProvider> | undefined
/** 本场景起点：别的场景的摘要调用会在同一个进程里累计，一律比差值不比绝对值。 */
let summaryCallsBefore = 0
/** 第 1 轮最后一次请求的**实测**视图（级 1 之后的形态）：对照相垫入量的推导基线。 */
let measuredBase = 0
/** 同一次请求里探针结果的级 1 形态估算：压缩后它被摘要替代，是垫入量的上限项之一。 */
let level1ResultTokens = 0
/** 对照相垫入的用户正文；未推导时为占位短句（此时对照相如实失败，不静默）。 */
let padText = "对照相载荷未推导。"
/** `debug.usage.main.total` 的本场景起点：上游口径的记账读数，比差值不比绝对值。 */
let mainTotalBefore = 0
const summaryRequests: string[] = []

/** 对照相才该被消费的脚本段：被非摘要请求取走就是脚本错位，立即报错。 */
const summaryStep: FauxResponseStep = context => {
  const text = lastRequestText(context)
  if (!text.includes("\"instructions\"")) throw new Error(`摘要脚本被非摘要请求取走: ${text.slice(0, 60)}`)
  summaryRequests.push(text)
  return fakeText(SUMMARY)
}

/** 消息正文（字符串或块数组两种形态）。 */
function textOfContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((part): part is { type?: string; text?: string } => typeof part === "object" && part !== null)
    .filter(part => part.type === "text")
    .map(part => part.text ?? "")
    .join("")
}

/**
 * 级 1（缩短）形态在请求视图里的期望值：`projectToolResultText` 的唯一产出 ——
 * 头段 + 占位提示行 + 尾段（`tool-output.ts:159-161`）。用真实函数重算，场景不复制切法与模板。
 */
function level1Shape(text: string, address: string): string {
  return projectToolResultText(text, address, WINDOW_TOKENS, SESSION_TRANSCRIPT_TOOL, 1)
}

/**
 * 级 1 形态里的回读地址：模板边界取自唯一实现 `toolResultNotice`（传入受理下界长度的占位地址，
 * 取其左右两侧为地址值的边界）—— 模板一改，边界跟着改，不会因为抄的模板过期而假绿。
 * 抽不到（没有地址行 / 不是缩短形态）返回 undefined，由调用点如实失败。
 */
function level1AddressOf(text: string): string | undefined {
  const probeRef = "0".repeat(MIN_ADDRESS_PREFIX)
  const notice = toolResultNotice(probeRef, SESSION_TRANSCRIPT_TOOL, "shortened")
  const at = notice.indexOf(probeRef)
  if (at < 0) throw new Error(`地址通知模板不再回显传入的地址：${notice}（场景自身的断言前提被破坏）`)
  const head = notice.slice(0, at)
  const tail = notice.slice(at + probeRef.length)
  const start = text.indexOf(head)
  if (start < 0) return undefined
  const rest = text.slice(start + head.length)
  const end = rest.indexOf(tail)
  return end < 0 ? undefined : rest.slice(0, end)
}

/** 探针结果的存档正文（投影的**真实输入**：投影只改请求视图，存档恒为全文，X-2）。 */
async function storedProbeText(): Promise<string> {
  const entries = await sessionEntries(getActiveSessionId())
  const stored = entries.find(entry => entry.type === "message" && entry.message.role === "toolResult"
    && entry.message.toolName === PROBE_TOOL_NAME)
  if (!stored || stored.type !== "message" || stored.message.role !== "toolResult") {
    throw new Error("会话条目里没有探针结果：请求视图的形态无法按存档推导")
  }
  return textOfContent(stored.message.content)
}

/**
 * 请求视图里的探针结果必须与级 1 的唯一产出**逐字相等**，返回这份视图正文。
 *
 * 为什么判据不是「≤ 单条上限」：单条上限只判**候选资格**（原始正文超它才进阶梯），裁剪预算
 * 只约束头尾两段（各 ≤ `floor(单条上限/2)` token），占位提示行与两侧换行是**额外**开销 ——
 * 「级 1 形态 ≤ 单条上限」从来不是产品契约：128k 窗口下实测 5217 + 5217 + 27 = **10461**
 * 对单条上限 10435，超出的正是这一行（地址 8–11 字符时逐字可复现）。
 * 逐字相等同时钉住三件事：切法是头尾各半、提示行来自唯一模板、地址是当次真实发出的前缀。
 */
async function expectLevel1ProbeResult(): Promise<string> {
  const sent = sentProbeResults()
  if (sent.length !== 1) throw new Error(`请求视图里的探针结果应为 1 条，实际 ${sent.length} 条｜${sizing()}`)
  const sentText = sent[0]!
  const address = level1AddressOf(sentText)
  if (address === undefined) {
    throw new Error(`请求视图里的探针结果不是级 1 形态（抽不到回读地址行）：`
      + `${JSON.stringify(sentText.slice(0, 120))}｜${sizing()}`)
  }
  const expected = level1Shape(await storedProbeText(), address)
  if (sentText !== expected) {
    throw new Error(`请求视图里的探针结果不是级 1 的逐字产出：视图 ${estimateContextTokens(sentText)} token / ${sentText.length} 字符，`
      + `重算 ${estimateContextTokens(expected)} token / ${expected.length} 字符（地址 ${address}）｜${sizing()}`)
  }
  return sentText
}

/** 发出去的探针结果正文（请求视图形态）：按顺序收集所有请求里的同一条工具结果。 */
function sentProbeResults(): string[] {
  const texts: string[] = []
  for (const payload of provider?.payloads ?? []) {
    for (const message of payload.messages) {
      if (message.role !== "toolResult" || message.toolName !== PROBE_TOOL_NAME) continue
      texts.push(textOfContent(message.content))
    }
  }
  return texts
}

/** 断言失败时带上真实口径，别让人从「没花调用」反推载荷。 */
function sizing(): string {
  return `窗口 ${WINDOW_TOKENS}、hardInputLimit ${BUDGET.hardInputLimit}、normalInputTarget ${BUDGET.normalInputTarget}`
    + `、压缩余量 ${BUDGET.compactionHeadroom}、单条上限 ${L0_TOKENS}`
    + `；探针结果 ${PROBE_RESULT.length} 字符 ≈ ${estimateContextTokens(PROBE_RESULT)} token`
    + `；对照相实测基线 ${measuredBase}（其中级 1 形态 ${level1ResultTokens}）`
    + `、垫入 ${padText.length} 字符 ≈ ${estimateContextTokens(padText)} token`
    + `；上游口径的第 1 轮记账合计 ${debug.usage.main.total - mainTotalBefore}`
}

/**
 * 只读探针：真实注册、真实过权限链路、真实执行，唯一变量就是「返回一条超目标的结果」。
 * 声明 `resultProjection: "reference"` 才会进阶梯候选（preserve 的结果不做级 1/级 2）。
 */
const probeTool = defineTool({
  id: PROBE_TOOL_ID,
  name: PROBE_TOOL_NAME,
  description: "级 3 闸门探针：返回单条超过 normalInputTarget 的只读结果，用于验证级 1/2 装得下时不花摘要调用",
  parameters: { type: "object", properties: {} },
  safetyLevel: "SAFE",
  source: "local",
  sourceId: "",
  actionCategory: "_default",
  policy: {
    version: TOOL_POLICY_VERSION,
    permission: { defaultDecision: "allow" },
    execution: { effect: "read", isolation: "shared_read", replay: "never" },
    context: { resultProjection: "reference", historyCompaction: "summarize" },
  },
}, async () => ({ success: true, content: PROBE_RESULT }))

/** 对照轮的正文在阶段 1 的断言里现场推导：这里留一个合法占位，推导失败时如实失败。 */
const contrastTurn: TurnDef = {
  index: 2,
  description: "对照相：级 1 之后仍超目标，摘要照常发出",
  userText: padText,
  checks: [{
    type: "expectContrastCompaction", run: async context => {
      try {
        const sessionId = getActiveSessionId()
        if (context.output.failure) throw new Error(`对照相回合失败: ${context.output.failure.message}`)
        // ① 同一个计数面：装不下时摘要调用恰好 +1（省钱那一相是 +0）。
        if (debug.usage.compaction.calls !== summaryCallsBefore + 1) {
          throw new Error(`对照相没有恰好发出一次摘要调用：compaction.calls ${summaryCallsBefore} → ${debug.usage.compaction.calls}`
            + `（阈值未触发、或级 1 之后的视图其实压得下去）｜${sizing()}`)
        }
        // ② 恰好一条 compaction 条目，且由宿主 before_compaction 内核提交。
        const compactions = compactionEntries(await sessionEntries(sessionId))
        if (compactions.length !== 1) {
          throw new Error(`对照相的 compaction 条目应为 1 条，实际 ${compactions.length} 条｜${sizing()}`)
        }
        const compaction = compactions[0]!
        if (!compaction.fromHook) throw new Error("对照相的 compaction 条目不是宿主 before_compaction 内核提交的")
        if (!compaction.summary.includes(SUMMARY_MARKER)) throw new Error("对照相的摘要不是内核产出的结构化摘要")
        // ③ 换代身份推进：压缩真的提交了（零提交与零调用不是同一件事）。
        if ((harnessSlots.snapshot(sessionId)?.contextEpoch ?? 0) < 1) throw new Error("对照相压缩后 contextEpoch 未推进")
        // ④ 压缩后回合照常收尾：脚本最后一段回复被消费。
        if (!context.output.reply.includes(REPLY_2)) {
          throw new Error(`对照相回复不是脚本最后一段: ${JSON.stringify(context.output.reply.slice(0, 60))}｜${sizing()}`)
        }
        // ⑤ 摘要范围不覆盖垫入的用户正文（它在 retainedTail 里）：摘要照常发出的原因是视图压不下去，
        //    不是把垫入量也摘要掉了 —— 后者会让「装不下」的结论失真。
        if (summaryRequests.length !== 1) throw new Error(`对照相的摘要请求应为 1 次，实际 ${summaryRequests.length} 次`)
        if (summaryRequests[0]!.includes(PAD_MARKER)) {
          throw new Error("对照相的摘要范围覆盖了垫入的用户正文：级 1 之后的视图本该仍含它")
        }
      } finally {
        // 探针只属于本场景：断言失败也要把它移出注册表。
        unregister(PROBE_TOOL_ID)
      }
    },
  }],
}

export const 阶梯闸门: SceneDef = {
  meta: {
    caseId: "memory-ladder-gate",
    module: "memory",
    contractId: "mm-32",
    description: "级 3 闸门：级 1/2 压完装得下时摘要 LLM 一次都不花（按 purpose 计数），压不下去时摘要照常发出",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["memory", "compaction", "boundary", "error"],
  },
  setup: async () => {
    summaryRequests.length = 0
    summaryCallsBefore = debug.usage.compaction.calls
    mainTotalBefore = debug.usage.main.total
    measuredBase = 0
    level1ResultTokens = 0
    padText = "对照相载荷未推导。"
    contrastTurn.userText = padText
    unregister(PROBE_TOOL_ID)
    register(probeTool)
    provider = installFakeProvider([
      fakeToolCall(PROBE_TOOL_NAME, {}, "ladder-gate-call"),
      fakeText(REPLY_1),
      summaryStep,
      fakeText(REPLY_2),
    ], FAKE_MODEL)
    await initChat()
  },
  turns: [
    {
      index: 1,
      description: "探针返回超目标结果：级 1 压完装得下，摘要调用一次都不花",
      userText: FIRST,
      checks: [
        {
          type: "expectContrastPayloadSized", run: async () => {
            // 对照相的垫入量按**实测**推导：系统前缀与工具面的 token 不写死，写死一定随
            // 系统提示词/工具集漂移（带宽只有 compactionHeadroom）。
            const payload = provider?.payloads[provider.payloads.length - 1]
            if (!payload) throw new Error("fake provider 没有记录到第 1 轮的请求 payload")
            if (debug.lastSystemTokens <= 0) {
              throw new Error("拿不到实测的系统前缀 token（debug.lastSystemTokens <= 0）：对照相载荷无法按运行期口径推导")
            }
            const sentTools = payload.tools ?? []
            const toolTokens = sentTools.length > 0 ? estimateValueTokens(sentTools.map(toolBudgetSchema)) : 0
            const messageTokens = payload.messages.reduce((total, message) => total + estimateMessageTokens(message), 0)
            measuredBase = debug.lastSystemTokens + toolTokens + messageTokens

            // 级 1 形态与唯一实现的产出逐字相等（详见 `expectLevel1ProbeResult`）：上限项取的是
            // **实测**的级 1 读数，它不是「≤ 单条上限」（头尾各半的裁剪预算之外还有提示行开销）。
            level1ResultTokens = estimateContextTokens(await expectLevel1ProbeResult())

            // 垫入量 = 让「压缩后的请求视图」贴住硬上限：压缩把被覆盖的工具结果换成摘要，
            // 其余（含垫入的用户正文）留在视图里。贴住硬上限同时把上游 `tokensBefore`
            // （使用量 + 尾随 chars/4）顶到阈值之上 —— 两侧余量都在下面断言。
            const padTokens = BUDGET.hardInputLimit - POST_VIEW_SAFETY + level1ResultTokens
              - BUDGET.summaryMaxTokens - measuredBase
            if (padTokens < 1) {
              throw new Error(`对照相没有垫入空间（实测基线 ${measuredBase} 已贴近硬上限）：需缩小探针载荷｜${sizing()}`)
            }
            padText = `${PAD_MARKER}${PAD_UNIT.repeat(Math.ceil(padTokens * 4 / PAD_UNIT.length))}`
            contrastTurn.userText = padText

            const padMessage = estimateMessageTokens({ role: "user", content: padText })
            const viewAfterLevel1 = measuredBase + padMessage
            if (viewAfterLevel1 <= BUDGET.normalInputTarget) {
              throw new Error(`对照相载荷不足：级 1 之后的视图 ${viewAfterLevel1} 没有超过 normalInputTarget ${BUDGET.normalInputTarget}`
                + `（基线 ${measuredBase} + 垫入 ${padMessage}）｜${sizing()}`)
            }
            // 压缩后的请求视图 = 级 1 之后的视图 − 被摘要覆盖的探针结果 + 摘要本身。
            const viewAfterCompaction = viewAfterLevel1 - level1ResultTokens + BUDGET.summaryMaxTokens
            if (viewAfterCompaction > BUDGET.hardInputLimit) {
              throw new Error(`对照相载荷越界：压缩后的请求视图 ${viewAfterCompaction} 超过 hardInputLimit ${BUDGET.hardInputLimit}`
                + `（级 1 之后 ${viewAfterLevel1}）｜${sizing()}`)
            }
            // 上游判据是它自己的读数（最近一次请求的 usage + 尾随 chars/4），与本仓估算器
            // 不完全同源（非 ASCII 计费、JSON 框架）。这里只钉「上游确实在记账」——
            // 真正的成败由对照相的计数断言判，读不到账时那条失败消息里带全部读数。
            const turnOneUsage = debug.usage.main.total - mainTotalBefore
            if (turnOneUsage <= 0) {
              throw new Error("第 1 轮没有上游 usage 记账（debug.usage.main.total 未增长）：对照相的阈值无法触发")
            }
          },
        },
        {
          type: "expectLadderGateDeclined", run: async context => {
            const sessionId = getActiveSessionId()
            // ① 回合走完整条链路：脚本第 2 段回复被消费（探针调用 → 阈值检查点 → 回复）。
            if (context.output.failure) throw new Error(`省钱回合失败: ${context.output.failure.message}`)
            if (!context.output.reply.includes(REPLY_1)) {
              throw new Error(`省钱回合的回复不是脚本下一段: ${JSON.stringify(context.output.reply.slice(0, 60))}｜${sizing()}`)
            }
            // ② 一次摘要 LLM 都不花：按 purpose 真实计数的摘要调用数没有增加。
            if (debug.usage.compaction.calls !== summaryCallsBefore) {
              throw new Error(`级 1 装得下却花了摘要调用：compaction.calls ${summaryCallsBefore} → ${debug.usage.compaction.calls}｜${sizing()}`)
            }
            // ③ 零提交：没有 compaction 条目、换代身份不推进。
            const entries = await sessionEntries(sessionId)
            if (compactionEntries(entries).length !== 0) throw new Error("闸门 decline 后仍提交了 compaction 条目")
            if ((harnessSlots.snapshot(sessionId)?.contextEpoch ?? 0) !== 0) throw new Error("闸门 decline 推进了上下文换代身份")

            // ④ 非空性（形态）：探针结果单条就超目标，进请求视图时真的被级 1 投影过。
            const rawTokens = estimateContextTokens(PROBE_RESULT)
            if (rawTokens <= BUDGET.normalInputTarget) {
              throw new Error(`载荷不足：探针结果单条 ${rawTokens} token 没有超过 normalInputTarget ${BUDGET.normalInputTarget}｜${sizing()}`)
            }
            if (rawTokens <= L0_TOKENS) {
              throw new Error(`载荷不足：探针结果单条 ${rawTokens} token 没有超过单条上限 ${L0_TOKENS}，不进阶梯候选｜${sizing()}`)
            }
            const stored = entries.find(entry => entry.type === "message" && entry.message.role === "toolResult"
              && entry.message.toolName === PROBE_TOOL_NAME)
            if (!stored || stored.type !== "message" || stored.message.role !== "toolResult") {
              throw new Error("会话条目里没有探针结果")
            }
            const storedText = textOfContent(stored.message.content)
            if (!storedText.includes(CORE_MARKER) || storedText.length < PROBE_RESULT.length) {
              throw new Error(`存档的探针结果不是全文（${storedText.length} 字符）：缩短只能发生在请求视图上`)
            }
            // 视图正文 = 级 1 的唯一产出（逐字相等）：判据不是「≤ 单条上限」——单条上限只判候选
            // 资格，头尾各半的裁剪预算之外还有占位提示行的固定开销（128k 下实测 10461 > 10435）。
            const sentText = await expectLevel1ProbeResult()
            if (sentText === PROBE_RESULT) {
              throw new Error("请求视图里的探针结果等于原文：级 1 没有投影，本场景的「装得下」不成立")
            }
            if (!sentText.includes(L0_SHORTENED_TAG)) {
              throw new Error(`请求视图里的探针结果没有级 1 缩短标记: ${JSON.stringify(sentText.slice(0, 120))}｜${sizing()}`)
            }
            if (sentText.includes(CORE_MARKER)) throw new Error("请求视图里仍能看到被裁掉的正文中段：投影不是级 1 形态")
            // ⑤ 非空性（C-4 的前提）：**实测的请求视图**（级 1 之后）装得下 —— 这是「级 1/2 压完
            //    装得下」这句断言的全部证据；原文装不下由 ④ 的 rawTokens 钉住。
            if (measuredBase <= 0) throw new Error(`没有量到第 1 轮的请求视图（对照相载荷推导也没跑成）｜${sizing()}`)
            if (measuredBase > BUDGET.normalInputTarget) {
              throw new Error(`级 1 之后的请求视图 ${measuredBase} 仍超 normalInputTarget ${BUDGET.normalInputTarget}：`
                + `C-4 的前提（装得下）不成立｜${sizing()}`)
            }

            // ⑥ 非空性（阈值路径真的被走到）：工具结果刚落盘的那个检查点，上游的 `tokensBefore`
            //    必然越过阈值 —— 用上游同一组判定函数在**那一刻的条目**上复算。少了这一条，
            //    上面的 0 次调用可能只是「阈值压缩压根没被触发」。
            const landedIndex = entries.findIndex(entry => entry.type === "message" && entry.message.role === "toolResult"
              && entry.message.toolName === PROBE_TOOL_NAME)
            const prepared = prepareCompaction(entries.slice(0, landedIndex + 1), SETTINGS)
            if (!prepared.ok) throw new Error(`复算压缩准备失败: ${prepared.error.message}`)
            const preparation = prepared.value
            if (preparation === undefined) {
              throw new Error("工具结果刚落盘时没有可压缩的准备结果：阈值压缩路径没有被走到｜" + sizing())
            }
            if (!shouldCompact(preparation.tokensBefore, WINDOW_TOKENS, SETTINGS)) {
              throw new Error(`阈值条件不成立（tokensBefore ${preparation.tokensBefore} ≤ ${WINDOW_TOKENS - SETTINGS.reserveTokens}）：`
                + `阈值压缩路径没有被走到，本场景的 0 次调用不成立｜${sizing()}`)
            }
          },
        },
      ],
    },
    contrastTurn,
  ],
}

export default 阶梯闸门
