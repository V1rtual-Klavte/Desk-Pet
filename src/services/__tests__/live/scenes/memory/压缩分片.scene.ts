import type { AgentMessage, Entry } from "@earendil-works/pi-agent-core"
import type { Context, FauxModelDefinition, FauxResponseStep } from "@earendil-works/pi-ai"
import { contentText } from "@earendil-works/pi-ai"
import { formatStructuredSummary, parseStructuredSummary } from "@/services/agent/memory"
import { initChat, sendMessage } from "@/services/agent/runner"
import { aiConfig } from "@/services/config"
import { contextBudget, estimateRequestTokens } from "@/services/context"
import { COMPACTION_SLICE_RATIO, MAX_COMPACTION_SLICES, measureCompactionMaterial } from "@/services/engine"
import type { CompactionMaterial } from "@/services/engine"
import { compactActiveSession, compactionSettingsFor } from "@/services/engine/pi"
import { getActiveSessionId } from "@/services/session"
import { TOOL_POLICY_VERSION, defineTool, getToolByName, register, unregister } from "@/services/tool"
import type { ToolDef } from "@/services/tool"
import { fakeText, fakeToolCall, installFakeProvider } from "../../fake-provider"
import { compactionEntries, sessionEntries } from "../../session-entries"
import type { SceneDef } from "../../types"

// ==========================================
// B-1 / B-2 / 问题 B 的生产场景：超硬上限的摘要素材**不 decline**，而是分片产出摘要并一次性提交
//
// 本场景证的是**真实链路的分片迭代**：`initChat` + 真实工具链路（探针真的执行、结果真的落盘）
// + 真实 `completePiText`（每片一次一次性请求）+ 真实 `before_compaction` 钩子 + 真实 compaction
// 条目提交（恰好一条、`fromHook`）。内核与规划器的 unit 面在 `摘要分片规划`（`mm-33`，
// caseId `memory-compaction-shard-plan`）—— 分片不变式、两类 fatal、X-4 都在那边，
// 本场景不重复规划器断言，只钉「生产入口上它真的这么跑」。同一 caseId 的 turn 3（连续第二次
// 分片压缩与跨压缩迭代）由 T4.08 在本文件追加。
//
// ── 载荷（源方案 §1.4 的可执行版，全部由预算常量推导）──
//
// 光靠正文体量到不了硬上限：主请求视图被宿主硬预算闸门封在 `hardInputLimit` 以内，摘要素材
// 是它的子集。真正可达的机制是**素材的 JSON 序列化放大**——`measureCompactionMaterial` 的估算
// 跑在 `JSON.stringify` 之后，ASCII 的双引号在正文里变成 `\"`，字符数翻倍，于是
// **素材成本 = 视图成本 × 2**。`resultProjection: "preserve"` 在此是必需条件：素材侧阶梯会把
// 非 preserve 的长结果缩到单条上限（≈10.4k tokens），两块合计 ≈21k，第一层就消化掉了，
// 永远到不了第二层 —— 这正是 `expectPreserveGatesFirstLayer` 的一对断言。
//
// 用户轮 1 连续调用 preserve 探针两次（`maxToolCallsPerTurn` 默认 5，够）：
// 视图 ≈ 2 × PROBE_VIEW_TOKENS、素材 ≈ 4 × PROBE_VIEW_TOKENS > hardInputLimit，
// 而每个工具批次（assistant + 其 toolResult）单独 ≈ 2 × PROBE_VIEW_TOKENS、低于单片预算
// ⇒ 可分片、不是 oversized_unit。探针大小取「素材侧刚过硬上限」与「视图侧留在阈值以内」
// 两个前提的中点（见下面的 `PROBE_VIEW_TOKENS`），两边各留 ≈1 万 token 余量。
//
// ── 两个必须避开的坑（违约会在规划阶段直接 fatal，场景永远到不了 completed）──
//
// ① **探针不能留在 `turnPrefixMessages` 里**：`turnPrefixFrom..end` 合成**永不切分**的
//    前缀单元（T4.00 的 prefixUnit），两段探针合起来 4 × PROBE_VIEW_TOKENS > `hardInputLimit`
//    ⇒ 规划直接返回 `fatal{oversized_unit}`。轮 1 之后**不再有别的用户输入**、且轮 2 的正文
//    自己越过保留窗口（见 ②），上游 `findCutPoint` 的切点才落在**用户消息**上（isSplitTurn = false，
//    `turnPrefixMessages` 为空），两段探针整体进 `messagesToSummarize`。
// ② **轮 2 的用户正文要自己超过 `keepRecentTokens`**（上游对 user 正文按 ceil(chars / 4) 计
//    ⇒ 本场景取 1.05 倍保留窗口的 ASCII 正文）：切点落在它身上，而不是落进轮 1 的 assistant
//    消息上（那会把整轮探针变成前缀单元，回到坑 ①）。`summaryInput()` 每次断言前先核对这条前提。
//
// ── 探针的对照声明与载荷口径 ──
//
// 注册两个探针（`preserve` 与 `reference`，结果同长度），**只调用 preserve 探针两次**：
// reference 结果会被 L0 缩短到单条上限（`toolResultTokenBudget`），既让素材不再是
// 「素材 = 2 × 视图」这个可推导的形态，又给请求视图多塞一份缩短后的正文 ——
// 而视图余量正是「阈值压缩不在回合内先发生」的余量。
// 「preserve 让第一层无效、只能靠第二层」的对照由**同一份实发素材**上的两次测量给出
// （带 / 不带 `preserveToolNames`），不靠多烧一次探针调用。

const PRESERVE_TOOL_ID = "shard-preserve-probe"
const PRESERVE_TOOL_NAME = "shard_preserve_probe"
const REFERENCE_TOOL_ID = "shard-reference-probe"
const REFERENCE_TOOL_NAME = "shard_reference_probe"
const PRESERVE_TOOL_NAMES: ReadonlySet<string> = new Set([PRESERVE_TOOL_NAME])

const FAKE_MODEL: FauxModelDefinition = { id: "deskpet-fake", name: "Desk-Pet Fake", contextWindow: 131_072, maxTokens: 16_384 }
/** 真正生效的窗口与 `resolvePiTurnModel` 一致：配置值与注入模型窗口取小（maxTokens 由预算覆盖）。 */
const WINDOW_TOKENS = Math.min(aiConfig.contextMaxTokens, 131_072)
const BUDGET = contextBudget(WINDOW_TOKENS)
/** 压缩设置与 `harness-slot.ts` 同一条表达式（maxOutput 取同一个预算的 outputReserve）：保留窗口从这里来。 */
const SETTINGS = compactionSettingsFor(WINDOW_TOKENS, BUDGET.outputReserve)
/** 单片素材预算：与 `summarizeCompaction` 传给规划器的实参同一条表达式，不另写一份口径。 */
const SLICE_BUDGET = Math.floor(BUDGET.hardInputLimit * COMPACTION_SLICE_RATIO)

/** 轮 2 正文的余量：切点条件是「≥ 保留窗口」，留 5% 防估算取整与配置漂移。 */
const TAIL_MARGIN = 1.05
/** 轮 2 的 ASCII 正文长度：上游对 user 正文按 ceil(chars / 4) 估算（`findCutPoint` 的累加口径）。 */
const TAIL_CHARS = Math.ceil(SETTINGS.keepRecentTokens * 4 * TAIL_MARGIN)
const TAIL_TOKENS = Math.ceil(TAIL_CHARS / 4)

/**
 * 单条探针的**视图**成本（ASCII 4 字符 ≈ 1 token）。夹在两侧前提之间，取容许区间的中点：
 *
 * - 素材侧：两条结果的素材 = 4 × 本值（JSON 转义翻倍）必须**超过硬上限** ⇒ 本值 > hardInputLimit / 4；
 * - 视图侧：两条结果的视图 + 轮 2 正文（2 × 本值 + 尾段）必须留在**阈值**（normalInputTarget）
 *   以内 —— 阈值压缩先于硬预算触发，回合内的 checkpoint 一旦越过它，第一次压缩就发生在轮 2 里，
 *   随后 /compact 面对的是已被压过的素材（本场景的分片前提被破坏）。
 *
 * 中点在两侧各留 ≈1 万 token 余量：两边都吃系统前缀与估算偏差（源方案 §1.4 的 160,000 是按**硬上限**
 * 单侧留余量推的，用在阈值侧只剩 ≈3,300 token，会被宿主卡片/工具集的体量吃掉）。
 */
const PROBE_VIEW_TOKENS = Math.floor((BUDGET.hardInputLimit / 4 + (BUDGET.normalInputTarget - TAIL_TOKENS) / 2) / 2)
const PROBE_CHARS = PROBE_VIEW_TOKENS * 4
const PROBE_RESULT = "\"".repeat(PROBE_CHARS)

const FIRST_TEXT = `第一轮：连续调用 ${PRESERVE_TOOL_NAME} 两次，然后回复我。`
const SECOND_TEXT = `第二轮：${"a".repeat(TAIL_CHARS)}`

/** 断言失败时带上真实口径，不让人从「未覆盖」反推载荷问题。 */
function sizing(): string {
  return `窗口 ${WINDOW_TOKENS}、hardInputLimit ${BUDGET.hardInputLimit}、阈值 ${BUDGET.normalInputTarget}`
    + `、sliceBudget ${SLICE_BUDGET}、单条探针 ${PROBE_CHARS} 字符（视图 ${PROBE_VIEW_TOKENS} tokens）`
    + `、保留窗口 ${SETTINGS.keepRecentTokens}、轮 2 正文 ${TAIL_CHARS} 字符（${TAIL_TOKENS} tokens）`
}

/**
 * 载荷前提（setup 里显式失败）：素材必须真的超硬上限、视图（未计系统前缀）必须留在阈值以内、
 * 轮 2 正文必须自己越过保留窗口、每个工具批次必须装得进单片预算。
 * 四条都由上面同一批预算常量推导 —— 窗口或估算器口径漂移时先在这里给出可读原因，
 * 不让断言在错误载荷上空转（同 `压缩降级` 的 `assertPayloadPremise`）。
 */
function assertPayloadPremise(): void {
  // 素材成本 = 视图成本 × 2（JSON 转义）：两条探针的素材 ≈ 4 × PROBE_VIEW_TOKENS tokens。
  const material = 4 * PROBE_VIEW_TOKENS
  if (!(material > BUDGET.hardInputLimit)) {
    throw new Error(`场景载荷前提不成立：两条探针的素材 ${material} 不超过硬上限 ${BUDGET.hardInputLimit}｜${sizing()}`)
  }
  const view = 2 * PROBE_VIEW_TOKENS + TAIL_TOKENS
  if (!(view < BUDGET.normalInputTarget)) {
    throw new Error(`场景载荷前提不成立：请求视图 ${view}（未计系统前缀）越过压缩阈值 ${BUDGET.normalInputTarget}：`
      + `回合内会先发生阈值压缩，手动 /compact 面对的是已被压过的素材｜${sizing()}`)
  }
  if (!(TAIL_TOKENS >= SETTINGS.keepRecentTokens)) {
    throw new Error(`场景载荷前提不成立：轮 2 正文 ${TAIL_TOKENS} tokens 没有越过保留窗口 ${SETTINGS.keepRecentTokens}｜${sizing()}`)
  }
  if (!(2 * PROBE_VIEW_TOKENS < SLICE_BUDGET)) {
    throw new Error(`场景载荷前提不成立：单个工具批次 ${2 * PROBE_VIEW_TOKENS} 装不进单片预算 ${SLICE_BUDGET}（不可分片）｜${sizing()}`)
  }
}

/** 声明指定 `resultProjection` 的只读探针：链路真实，唯一变量就是投影声明（同 `摘要投影口径`）。 */
const probe = (id: string, name: string, projection: "preserve" | "reference", result: string): ToolDef =>
  defineTool({
    id, name,
    description: `分片探针 ${name}：声明 resultProjection=${projection} 的长结果工具`,
    parameters: { type: "object", properties: {} },
    safetyLevel: "SAFE", source: "local", sourceId: "", actionCategory: "_default",
    policy: {
      version: TOOL_POLICY_VERSION,
      permission: { defaultDecision: "allow" },
      execution: { effect: "read", isolation: "shared_read", replay: "never" },
      context: { resultProjection: projection, historyCompaction: "summarize" },
    },
  }, async () => ({ success: true, content: result }))

/** 一次真实请求的投影采样：视图前提的唯一证据（系统提示、消息与工具 schema 都取当下值）。 */
interface ViewSample {
  label: string
  systemPrompt: string
  messages: Context["messages"]
  tools: Context["tools"]
  used: number
}

const viewSamples: ViewSample[] = []

/**
 * 脚本步骤 + 视图采样：请求由真实链路发出，采样点只旁听，不改写响应。
 *
 * **采样的是「本步之前已经落进上下文的消息」**：faux 在每次请求时弹出下一步，所以第 N 步看到的
 * 上下文里已有前 N−1 步产生的工具结果 —— 第 3 步（收尾回复）才是同时带着两条探针结果的那次请求。
 */
function recorded(label: string, step: FauxResponseStep): FauxResponseStep {
  return (context, options, state, model) => {
    const systemPrompt = context.systemPrompt ?? ""
    viewSamples.push({
      label, systemPrompt, messages: context.messages, tools: context.tools,
      used: estimateRequestTokens(systemPrompt, context.messages, context.tools),
    })
    return typeof step === "function" ? step(context, options, state, model) : step
  }
}

// ── 摘要脚本：只替换 Provider，摘要请求本身走真实 `completePiText` ──

/** 第 N 片的结构化摘要；末片的 intent 用来证明提交正文来自末片（迭代不丢）。 */
function summaryResponse(slice: number): string {
  return JSON.stringify({
    intent: `第 ${slice} 片`, facts: [`第 ${slice} 片覆盖的素材`],
    corrections: [], pending: [], continuity: [], nextSteps: [],
  })
}

/** 每片请求的正文快照（断言从中读 `previousSummary` 与逐片消息）。 */
const summaryRequests: string[] = []

/** 摘要请求脚本：被非摘要请求取走就是脚本错位，立即报错（同 `压缩降级` 的做派）。 */
const summaryStep: FauxResponseStep = context => {
  const last = context.messages[context.messages.length - 1]
  const text = typeof last?.content === "string"
    ? last.content
    : (last?.content ?? []).map(part => (part.type === "text" ? part.text : "")).join("")
  if (!text.includes("\"instructions\"")) throw new Error(`摘要脚本被非摘要请求取走: ${text.slice(0, 60)}`)
  summaryRequests.push(text)
  return fakeText(summaryResponse(summaryRequests.length))
}

// ── 会话条目 → 素材（messagesToSummarize 的等价重建）──

/** 存档侧的工具结果条目：正文、工具名与条目 id 一起取。 */
function toolResults(entries: Entry[]): { id: string; toolName: string; text: string }[] {
  return entries.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult"
    ? [{ id: entry.id, toolName: entry.message.toolName ?? "", text: contentText(entry.message.content) }]
    : [])
}

/** 消息正文（字符串或块数组两种形态）。上游对 user 正文按 ceil(chars / 4) 估算，切点前提只数正文。 */
function messageText(message: AgentMessage): string {
  const content = (message as { content: Parameters<typeof contentText>[0] }).content
  return typeof content === "string" ? content : contentText(content)
}

/**
 * `preparation.messagesToSummarize` 的等价重建：切点之前的全部 message 条目。
 *
 * 切点前提在这里核对（每次断言前重算，不靠 setup 的一次性结论）：轮 2 的用户正文自己
 * ≥ 保留窗口（上游按 ceil(chars / 4) 累加）⇒ `findCutPoint` 在它身上第一次越过保留窗口，
 * 切点落在**用户消息**上（isSplitTurn = false）⇒ `turnPrefixMessages` 为空。
 * 前提不成立时直接给出可读原因：那时切点会落进轮 1，两段探针进永不切分的前缀单元，
 * 规划阶段就会 `fatal{oversized_unit}`，后面的断言全都失真。
 */
async function summaryInput(): Promise<{ messages: AgentMessage[]; cutTokens: number }> {
  const entries = await sessionEntries()
  const messages = entries.flatMap(entry => entry.type === "message" ? [entry.message] : [])
  let cut = -1
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]!.role === "user") { cut = index; break }
  }
  if (cut < 0) throw new Error(`会话里没有用户消息：轮 2 正文没有进入会话条目｜${sizing()}`)
  const cutTokens = Math.ceil(messageText(messages[cut]!).length / 4)
  if (cutTokens < SETTINGS.keepRecentTokens) {
    throw new Error(`轮 2 正文自己 ${cutTokens} tokens 没有越过保留窗口 ${SETTINGS.keepRecentTokens}：`
      + `切点会落进轮 1 ⇒ 探针进 turnPrefixMessages ⇒ 规划直接 fatal oversized_unit｜${sizing()}`)
  }
  return { messages: messages.slice(0, cut), cutTokens }
}

/** 素材投影里的一条消息（`measureCompactionMaterial` 的 `Message` 形态）。 */
interface ProjectedMessage {
  role?: unknown
  text?: unknown
  toolCallId?: unknown
  isError?: unknown
  eventId?: unknown
  toolCalls?: unknown
}

function projectedMessages(body: { messages?: unknown[]; splitTurnPrefix?: unknown[] }): ProjectedMessage[] {
  return [...(body.messages ?? []), ...(body.splitTurnPrefix ?? [])] as ProjectedMessage[]
}

/**
 * 内容指纹：`id` 是**片内下标**（`summary:<index>`，由切片位置决定），不是内容 ——
 * 比它等于比切片偏移，故只比内容字段。地址（`eventId` 与正文里的地址尾行）照比：
 * 基线用**实发的那批地址**重算（见 `issuedAddressRefs`），两路同源才能真比。
 */
function contentOf(message: ProjectedMessage): string {
  return JSON.stringify({
    role: message.role, text: message.text, toolCallId: message.toolCallId,
    isError: message.isError, eventId: message.eventId, toolCalls: message.toolCalls,
  })
}

/** 差异摘要：报告前几条内容指纹（不把 16 万字符的正文塞进错误消息）。 */
function briefOf(message: ProjectedMessage): string {
  const text = typeof message.text === "string" ? message.text : ""
  return `${String(message.role)}(${text.length} 字符)${JSON.stringify(text.slice(0, 32))}`
}

/**
 * 已发出的回读地址（`entryId → 展示用前缀`）：从 K 片请求正文里取回。
 * 前缀按定义是条目 id 的前缀，用 `startsWith` 反查条目 id，不拿完整 id 硬凑。
 */
function issuedAddressRefs(bodies: ProjectedMessage[][], ids: readonly string[]): Map<string, string> {
  const refs = new Map<string, string>()
  for (const messages of bodies) {
    for (const message of messages) {
      if (message.role !== "tool" || typeof message.eventId !== "string") continue
      const id = ids.find(candidate => candidate.startsWith(message.eventId as string))
      if (id !== undefined) refs.set(id, message.eventId)
    }
  }
  return refs
}

/** 素材的一条测量记录：供断言与错误消息复用（三次测量共用同一批消息与地址）。 */
function measured(messages: readonly AgentMessage[], preserve: ReadonlySet<string>, refs?: ReadonlyMap<string, string>): CompactionMaterial {
  return measureCompactionMaterial({
    messages,
    window: WINDOW_TOKENS,
    preserveToolNames: preserve,
    ...(refs ? { addressRefs: refs } : {}),
  })
}

// ── 断言：条目身份 ──

/** 错误文案里的条目身份：条目可能带着 16 万字符的正文，报告里只留类型、id 与序列化长度。 */
function entryBrief(entry: Entry): string {
  return `${entry.type}${entry.type === "custom" ? `/${entry.customType}` : ""}#${entry.id}`
    + `(${JSON.stringify(entry).length} 字符)`
}

/** 两段序列化的首个差异位置：改写对照用，避免把整份正文塞进错误消息。 */
function divergence(before: string, after: string): string {
  let index = 0
  while (index < before.length && index < after.length && before[index] === after[index]) index++
  return `首个差异在第 ${index} 字符：before=${JSON.stringify(before.slice(index, index + 120))}`
    + ` after=${JSON.stringify(after.slice(index, index + 120))}`
}

export const 压缩分片: SceneDef = {
  meta: {
    caseId: "memory-compaction-shard-iterate",
    module: "memory",
    contractId: "mm-19",
    description: "超硬上限的摘要素材在真实入口上分片：preserve 载荷让第一层无效，/compact 逐片串行产出摘要、第 N 片带上第 N−1 片的产出、恰好提交一条 compaction 条目且覆盖全量素材，原文条目逐字保留",
    depth: "deep",
    suite: "regression",
    entry: "production",
    tags: ["memory", "compaction", "boundary"],
  },
  setup: async () => {
    assertPayloadPremise()
    summaryRequests.length = 0
    viewSamples.length = 0
    unregister(PRESERVE_TOOL_ID)
    unregister(REFERENCE_TOOL_ID)
    register(probe(PRESERVE_TOOL_ID, PRESERVE_TOOL_NAME, "preserve", PROBE_RESULT))
    register(probe(REFERENCE_TOOL_ID, REFERENCE_TOOL_NAME, "reference", PROBE_RESULT))
    installFakeProvider([
      recorded("轮 1 / 第 1 次探针调用", fakeToolCall(PRESERVE_TOOL_NAME, {}, "shard-preserve-call-1")),
      recorded("轮 1 / 第 2 次探针调用", fakeToolCall(PRESERVE_TOOL_NAME, {}, "shard-preserve-call-2")),
      recorded("轮 1 / 收尾回复", fakeText("第一轮回复完成。")),
      recorded("轮 2 / 本轮回复", fakeText("第二轮回复完成。")),
      // 摘要脚本按片数上限备足：多出来的步骤不会被取走（被非摘要请求取走会立刻报错）。
      ...Array.from({ length: MAX_COMPACTION_SLICES }, () => summaryStep),
    ], FAKE_MODEL)
    await initChat()
  },
  turns: [
    {
      index: 1,
      description: "preserve 探针连续执行两次，结果全文落盘，且两次带结果的请求视图都在硬上限以内",
      userText: FIRST_TEXT,
      checks: [{ type: "expectProbeResultsStored", run: async context => {
        if (context.output.failure) throw new Error(`第一轮就失败：${context.output.failure.message}`)
        // 载荷声明先自证：两个探针的投影声明都在册（对照成立的前提是声明真的存在）。
        const preserved = getToolByName(PRESERVE_TOOL_NAME)?.policy.context.resultProjection
        const referenced = getToolByName(REFERENCE_TOOL_NAME)?.policy.context.resultProjection
        if (preserved !== "preserve" || referenced !== "reference") {
          throw new Error(`探针的投影声明漂了：${PRESERVE_TOOL_NAME}=${String(preserved)}、${REFERENCE_TOOL_NAME}=${String(referenced)}`)
        }
        // 探针真实执行：条目里恰好两条 preserve 探针结果，且都是**全文**（缩短只发生在投影上）。
        // 对照探针不参与载荷（见文件头的「对照声明与载荷口径」）：它一旦被调用就说明脚本错位。
        const results = toolResults(await sessionEntries())
        const preserve = results.filter(result => result.toolName === PRESERVE_TOOL_NAME)
        const reference = results.filter(result => result.toolName === REFERENCE_TOOL_NAME)
        if (reference.length !== 0) {
          throw new Error(`对照探针被调用（${reference.length} 条结果）：载荷被改动，素材与视图的数字不再同源｜${sizing()}`)
        }
        if (preserve.length !== 2) {
          throw new Error(`${PRESERVE_TOOL_NAME} 的结果应为 2 条（同轮连续两次），实际 ${preserve.length} 条`
            + `（现有工具结果：${JSON.stringify(results.map(result => result.toolName))}）｜${sizing()}`)
        }
        for (const result of preserve) {
          if (result.text.length < PROBE_CHARS) {
            throw new Error(`探针 ${result.id} 的存档结果不是全文（长度 ${result.text.length}，应 ≥ ${PROBE_CHARS}）：缩短只能发生在投影上`)
          }
        }
        // 视图前提：轮 1 的三次请求都由真链路发出且都未被硬预算闸门拦下（被拦下就不会有工具执行）。
        // 第三次请求（收尾回复）同时带着两条探针结果：它就是「两条结果以全文进视图」的证据 ——
        // preserve 在视图侧同样跳过 L0 缩短，否则这里会明显小于两条探针的视图成本。
        if (viewSamples.length !== 3) {
          throw new Error(`轮 1 的请求采样应为 3 次（两次探针调用 + 收尾回复），实际 ${viewSamples.length} 次`
            + `（脚本与真实循环不同步）｜${sizing()}`)
        }
        for (const sample of viewSamples) {
          if (sample.used > BUDGET.hardInputLimit) {
            throw new Error(`请求视图「${sample.label}」${sample.used} tokens 超过硬上限 ${BUDGET.hardInputLimit}：`
              + `视图会被闸门拦下（要么改走溢出恢复、要么探针根本不会执行）｜${sizing()}`)
          }
        }
        const withBoth = viewSamples[viewSamples.length - 1]!
        if (!(withBoth.used >= 2 * PROBE_VIEW_TOKENS)) {
          throw new Error(`两条探针结果都进了上下文的请求视图只有 ${withBoth.used} tokens，`
            + `小于两条探针的视图成本 ${2 * PROBE_VIEW_TOKENS}：preserve 结果没有以全文进视图（载荷机制不成立）｜${sizing()}`)
        }
      } }],
    },
    {
      index: 2,
      description: "手动压缩超硬上限素材：preserve 让第一层无效，分片串行产出摘要、逐片迭代、覆盖全量、恰好提交一条条目",
      userText: SECOND_TEXT,
      checks: [
        { type: "expectNoCompactionBeforeManual", run: async context => {
          if (context.output.failure) throw new Error(`第二轮失败：${context.output.failure.message}`)
          // 手动压缩必须面对**未被压过**的素材：轮 2 的请求视图若先被阈值命中，第一次压缩会在
          // 回合内发生，随后 /compact 面对的是已被压过的小素材（K 退化为 1）。如实失败，
          // 不让分片断言在「已经压过」的会话上以别的原因红。
          const compactions = compactionEntries(await sessionEntries())
          if (compactions.length !== 0) {
            throw new Error(`手动压缩前已有 ${compactions.length} 条 compaction 条目（阈值压缩在回合内先发生了）`
              + `：本轮素材已被压过，分片断言无法成立｜${sizing()}`)
          }
          if (summaryRequests.length !== 0) {
            throw new Error(`手动压缩前已经发出过 ${summaryRequests.length} 次摘要请求：回合内发生过压缩｜${sizing()}`)
          }
          // 轮 2 的请求视图（带着两条探针结果与轮 2 正文）：它必须装得进硬上限，且真的带着载荷。
          // 阈值（`normalInputTarget`）那边不在这里断言：那是 Harness 自己的读数（有 usage 时按
          // provider 的真实用量计），本仓估算在中文字符上更保守，拿它硬比会误红。载荷侧把
          // 「2 × 探针视图 + 尾段」压在阈值以下留出的余量，就是上面第一条断言成立的前提。
          if (viewSamples.length !== 4) {
            throw new Error(`到轮 2 断言为止的请求采样应为 4 次，实际 ${viewSamples.length} 次（脚本与真实循环不同步）｜${sizing()}`)
          }
          const latest = viewSamples[viewSamples.length - 1]!
          if (latest.used > BUDGET.hardInputLimit) {
            throw new Error(`轮 2 的请求视图「${latest.label}」${latest.used} tokens 超过硬上限 ${BUDGET.hardInputLimit}｜${sizing()}`)
          }
          if (!(latest.used >= 2 * PROBE_VIEW_TOKENS + TAIL_TOKENS)) {
            throw new Error(`轮 2 的请求视图「${latest.label}」只有 ${latest.used} tokens，`
              + `小于「两条探针 + 轮 2 正文」的视图成本 ${2 * PROBE_VIEW_TOKENS + TAIL_TOKENS}：载荷没有完整进请求｜${sizing()}`)
          }
        } },
        { type: "expectPreserveGatesFirstLayer", run: async () => {
          const { messages } = await summaryInput()
          // 素材重建必须与存档条目一一对应：两条探针结果都要在切点之内（否则是切点前提破了，
          // 不是载荷超限 —— 单独报出来，别让下面的读数掩盖真正的原因）。
          const materialResults = messages.filter(message => message.role === "toolResult")
          if (materialResults.length !== 2) {
            throw new Error(`messagesToSummarize 里的工具结果应为 2 条（两条探针），实际 ${materialResults.length} 条`
              + `：切点没有落在轮 2 的用户消息上｜${sizing()}`)
          }
          const preserve = toolResults(await sessionEntries()).filter(result => result.toolName === PRESERVE_TOOL_NAME)
          if (preserve.length !== 2) {
            throw new Error(`存档里的 preserve 结果应为 2 条，实际 ${preserve.length} 条（载荷在场景准备阶段就变了）｜${sizing()}`)
          }
          // ① 带 preserve 声明：两条结果禁止二次处理 ⇒ 素材 ≈ 2 × 80k > 硬上限，第一层（级 1/2）无效。
          const withPreserve = measured(messages, PRESERVE_TOOL_NAMES)
          if (!(withPreserve.used > BUDGET.hardInputLimit)) {
            throw new Error(`preserve 载荷的素材只有 ${withPreserve.used} tokens，未超硬上限 ${BUDGET.hardInputLimit}`
              + `（探针结果 ${preserve.map(result => result.text.length).join("/")} 字符）｜${sizing()}`)
          }
          // ② 去掉 preserve 声明（对照）：同一条结果被 L0 缩短，素材落回硬上限以内 —— 第一层就能消化，
          //    第二层根本不会被触发。这一对断言就是「preserve 让第一层无效、只能靠第二层」的用例。
          const withoutPreserve = measured(messages, new Set<string>())
          if (withoutPreserve.used > BUDGET.hardInputLimit) {
            throw new Error(`去掉 preserve 声明后素材仍有 ${withoutPreserve.used} tokens 超硬上限 ${BUDGET.hardInputLimit}`
              + `：对照失效（长结果没有被 L0 缩短，载荷不是靠 preserve 才超限的）｜${sizing()}`)
          }
          // preserve 全程停在级 0（禁止二次处理：不缩短、不清空）；对照侧必须真的升过级（否则说明
          // 长结果压根没进阶梯候选集，两条读数就不是「同一份素材的两种投影」）。
          if (withPreserve.level !== 0) {
            throw new Error(`带 preserve 声明时素材仍被升到级 ${withPreserve.level}：preserve 应停在级 0｜${sizing()}`)
          }
          if (withoutPreserve.level < 1) {
            throw new Error(`去掉 preserve 声明后素材没有被缩短（级 ${withoutPreserve.level}）：对照失效｜${sizing()}`)
          }
        } },
        { type: "expectShardedCompactionCompletes", run: async () => {
          const sessionId = getActiveSessionId()
          const before = await sessionEntries(sessionId)
          const { messages } = await summaryInput()
          // B-1 主断言：超硬上限的素材**不 decline**，分片产出摘要并一次性提交。
          const outcome = await compactActiveSession(sessionId)
          if (outcome.status !== "completed") {
            throw new Error(`手动压缩没有完成：status=${outcome.status}`
              + `${outcome.error ? ` (${outcome.error})` : ""}｜${sizing()}`)
          }
          const bodies = summaryRequests.map(text => JSON.parse(text) as { previousSummary?: unknown; messages?: unknown[]; splitTurnPrefix?: unknown[] })
          // K ≥ 2：分片真的发生了（K = 1 是单次路径，B-1 没有成立）。上限取实现常量，不另写数字。
          if (bodies.length < 2) {
            throw new Error(`摘要请求只有 ${bodies.length} 次：素材没有分片（单次路径会一次失败或一次成功）｜${sizing()}`)
          }
          if (bodies.length > MAX_COMPACTION_SLICES) {
            throw new Error(`摘要请求 ${bodies.length} 次超过片数上限 ${MAX_COMPACTION_SLICES}｜${sizing()}`)
          }
          // B-2 之一：逐片迭代 —— 第 1 片没有前序摘要，第 N 片带上第 N−1 片的产出（串行，不并行）。
          if (bodies[0]!.previousSummary !== null) {
            throw new Error(`第 1 片的 previousSummary 应为 null（首次压缩无前序摘要），实际 ${JSON.stringify(bodies[0]!.previousSummary)?.slice(0, 80)}`)
          }
          for (let index = 1; index < bodies.length; index++) {
            const previousSummary = parseStructuredSummary(summaryResponse(index))
            if (!previousSummary) throw new Error(`场景脚本第 ${index} 片的摘要不可解析（脚本自身有问题）`)
            const expected = formatStructuredSummary(previousSummary)
            const actual = bodies[index]!.previousSummary
            if (actual !== expected) {
              throw new Error(`第 ${index + 1} 片的 previousSummary 不是第 ${index} 片的产出（迭代链断了）：`
                + `实际 ${JSON.stringify(actual)?.slice(0, 120)}、应有 ${JSON.stringify(expected).slice(0, 120)}`)
            }
          }
          // B-2 之二：全量覆盖 —— K 片的 messages（prefix 片走 splitTurnPrefix）按顺序拼接，
          // 与「同一投影下的完整素材」逐项相同：无缺、无重、顺序不变。只读 messages 会静默漏掉
          // prefix 片的内容，这条是把两边都拼起来比。
          const slices = bodies.map(body => projectedMessages(body))
          const refs = issuedAddressRefs(slices, toolResults(before).map(result => result.id))
          if (refs.size === 0) {
            throw new Error("片请求正文里没有回读地址：基线无法与实发形态同源，覆盖对照会因地址尾行不同而假失败")
          }
          const baseline = measured(messages, PRESERVE_TOOL_NAMES, refs)
          const full = projectedMessages(JSON.parse(baseline.userText) as { messages?: unknown[]; splitTurnPrefix?: unknown[] })
          const flattened = slices.flat()
          if (flattened.length !== full.length) {
            throw new Error(`分片覆盖不全：K=${bodies.length} 片合计 ${flattened.length} 条素材消息，完整素材 ${full.length} 条`
              + `（各片 ${JSON.stringify(slices.map(slice => slice.length))}）｜${sizing()}`)
          }
          for (let index = 0; index < full.length; index++) {
            if (contentOf(flattened[index]!) !== contentOf(full[index]!)) {
              throw new Error(`分片覆盖在第 ${index} 条素材上不一致（缺失、重复或顺序变化）：`
                + `分片=${briefOf(flattened[index]!)}、完整素材=${briefOf(full[index]!)}｜${sizing()}`)
            }
          }
          // 提交面：恰好一条 compaction 条目、来自钩子、正文是**末片**产出（中间片只以摘要形态前进）。
          const after = await sessionEntries(sessionId)
          const compactions = compactionEntries(after)
          if (compactions.length !== 1) {
            throw new Error(`分片压缩应恰好提交 1 条 compaction 条目，实际 ${compactions.length} 条｜${sizing()}`)
          }
          const entry = compactions[0]!
          if (entry.fromHook !== true) throw new Error(`compaction 条目不是钩子产出（fromHook=${String(entry.fromHook)}）`)
          const lastIntent = `第 ${bodies.length} 片`
          if (!entry.summary.includes(lastIntent)) {
            throw new Error(`compaction 条目的正文不是末片产出（找不到「${lastIntent}」）：${entry.summary.slice(0, 120)}`)
          }
          // 原文条目一条不少、逐字不变（按 id 对齐；丢失与改写都在这里显形）。压缩只改请求视图。
          const beforeIds = new Set(before.map(item => item.id))
          const afterById = new Map(after.map(item => [item.id, item]))
          for (const item of before) {
            const kept = afterById.get(item.id)
            if (kept === undefined) throw new Error(`分片压缩丢掉了原文条目 ${entryBrief(item)}｜${sizing()}`)
            const [was, now] = [JSON.stringify(item), JSON.stringify(kept)]
            if (was !== now) throw new Error(`分片压缩改写了原文条目 ${entryBrief(item)}：${divergence(was, now)}`)
          }
          // 新增条目只能是证据类（compaction 条目本身、快照、派生记录）：压缩唯一改变的是请求视图，
          // 它不许把摘要或任何东西写成新的**消息**条目（那会改变读模型与后续素材）。
          const added = after.filter(item => !beforeIds.has(item.id))
          const addedMessages = added.filter(item => item.type === "message")
          if (addedMessages.length !== 0) {
            throw new Error(`分片压缩新增了消息条目（不应有任何一条）：${JSON.stringify(addedMessages.map(entryBrief))}`)
          }
          // 探针只属于本场景：观测完成后移出注册表（同 `摘要投影口径`）。
          unregister(PRESERVE_TOOL_ID)
          unregister(REFERENCE_TOOL_ID)
        } },
      ],
    },
  ],
}

export default 压缩分片
