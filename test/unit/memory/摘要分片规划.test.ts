// ==========================================
// 摘要分片规划 —— 从 test/e2e/scenes/memory/摘要分片规划.scene.ts 迁到 L2
// ==========================================
//
// W4 问题 B 的内核侧：分片规划器的不变式 + 超硬上限素材确实分片产出摘要 + 片数超上限明确失败
//
// 本测试证的是**内核与规划器**（`planCompactionShards` / `measureCompactionMaterial` /
// `summarizeCompaction`）：只调纯函数与被导出的内核入口，fake provider 只替换 Provider、
// 不跑真模型、不建会话。真实链路（production 入口 + preserve 载荷的逐片迭代）见 `压缩分片` 场景（L4）。
//
// 三条交接口径先写在最前，防止后来者按直觉读错：
//
// 1. **`fatal` 存在时 `ranges` 恒为 `[]`**（T4.00 的返回形态）。判「有没有可规划对象」必须
//    先判 `fatal` 再判 `ranges.length`；反过来读会把「片数超上限」误判成「没有可分对象」。
//    要断言真实片数请读 `fatal.needed` —— 它是贪心装箱数出来的片数，不是估算常数。
// 2. **`overhead + Σcosts === used` 是构造性恒等**（T4.01：`overhead` 的定义即 `used − Σcosts`）。
//    因此「片上成本」`overhead + Σ该片 costs` 与 `hardInputLimit` 同量纲，可以直接与硬上限比较；
//    本测试的每片可发断言与 oversized 判据都从这条恒等式推导，不另建第二份口径。
// 3. **预算数字一律运行期口径**：`contextBudget(window)`（**不传 `maxOutput`**）＋
//    `toolResultTokenBudget(window)`。hardInputLimit / 单条 L0 / sliceBudget / 片数上限
//    全部由这两个函数与 `COMPACTION_SLICE_RATIO` / `MAX_COMPACTION_SLICES` 推导，
//    测试不复制任何字面量（改预算只该改实现一处）。
//
// 载荷构造用源方案 §1.4 的可执行版：`N = ceil(hardInputLimit / L0 满额成本)`（128k 窗口 → 12），
// 且结果一律 `resultProjection=preserve` —— 素材投影会先按级 0→1→2 升档，非 preserve
// 的长结果会被缩短/清空（素材自己就小下去，永远到不了第二层）；preserve 全程停在级 0
// （preserve 的结果禁止二次处理），分片因此是它的唯一出路。前提在测试开头显式断言，
// 不让断言在错误载荷上空转（同 `压缩降级` 的 assertPayloadPremise）。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Context, FauxModelDefinition, FauxProviderState, FauxResponseStep } from "@earendil-works/pi-ai"
import type { AgentMessage } from "@earendil-works/pi-agent-core"

import { setTestDataRoot } from "../../host/node-ipc"
import { fakeText, installFakeProvider, lastRequestText } from "../../host/fake-provider"
import { formatStructuredSummary, parseStructuredSummary } from "@/services/agent/memory"
import { DEFAULT_CONTEXT_WINDOW, contextBudget, estimateValueTokens, toolResultTokenBudget } from "@/services/context"
import {
  COMPACTION_SLICE_RATIO,
  MAX_COMPACTION_SLICES,
  CompactionOverflowError,
  measureCompactionMaterial,
  planCompactionShards,
  summarizeCompaction,
} from "@/services/engine"
import type { CompactionMaterial, CompactionShardPlan } from "@/services/engine"
import { formatError } from "@/services/error"

/** 运行期窗口口径（`contextBudget` 的默认窗口）：不读本机 CONFIG，避免配置漂移。 */
const WINDOW = DEFAULT_CONTEXT_WINDOW
const BUDGET = contextBudget(WINDOW)
/** 单片素材预算：与 `summarizeCompaction` 里传给规划器的实参同一条表达式（同一旋钮、同一量纲）。 */
const SLICE_BUDGET = Math.floor(BUDGET.hardInputLimit * COMPACTION_SLICE_RATIO)
/** 单条 L0 满额成本：载荷尺寸与「N 条即超硬上限」的推导都从它出发。 */
const L0_TOKENS = toolResultTokenBudget(WINDOW)

const PRESERVE_TOOL = "summary_preserve_probe"
const PRESERVE_TOOL_NAMES: ReadonlySet<string> = new Set([PRESERVE_TOOL])
const FAKE_MODEL: FauxModelDefinition = {
  id: "deskpet-fake", name: "Desk-Pet Fake", contextWindow: WINDOW, maxTokens: 16_384,
}

let root = ""

/**
 * 本文件装过的 provider：afterEach 按安装逆序逐个 restore（跨场景的注入点不留残留）。
 * 走 `installFakeProvider` 的返回值而不是 `resetPiRuntimeProviderForTest` —— 后者在
 * `@/services/engine/pi`，import 它会让这一层（L2）撞上规则 6。
 */
const providerRestores: Array<() => void> = []

function installProvider(script: FauxResponseStep[], definition?: FauxModelDefinition): ReturnType<typeof installFakeProvider> {
  const provider = installFakeProvider(script, definition)
  providerRestores.push(provider.restore)
  return provider
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deskpet-memory-shard-"))
  setTestDataRoot(root)
})

afterEach(() => {
  for (const restore of providerRestores.splice(0).reverse()) restore()
  rmSync(root, { recursive: true, force: true })
})

// ── 合成素材：只填被测函数真正读取的字段 ──
//
// `planCompactionShards` 只读 `role` / `content`（toolCall 块）/ `toolCallId`；
// `measureCompactionMaterial` 另读 `timestamp` / `toolName` / `isError` / `details`。
// 字段按真实 Pi 消息形态给，其余（api/provider/usage…）与两条投影无关，不填。

interface ProbeMessage {
  role: string
  content: unknown
  timestamp: number
  toolCallId?: string
  toolName?: string
  isError?: boolean
  details?: { deskpetEntryId: string }
}

const asMaterial = (messages: readonly ProbeMessage[]): AgentMessage[] => messages as unknown as AgentMessage[]

const userMessage = (text: string, timestamp: number): ProbeMessage => ({ role: "user", content: text, timestamp })
const assistantCall = (id: string, timestamp: number): ProbeMessage => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name: PRESERVE_TOOL, arguments: {} }],
  timestamp,
})
const toolResult = (id: string, text: string, timestamp: number, address?: string): ProbeMessage => ({
  role: "toolResult", toolCallId: id, toolName: PRESERVE_TOOL,
  content: [{ type: "text", text }], isError: false, timestamp,
  ...(address === undefined ? {} : { details: { deskpetEntryId: address } }),
})

/** 构造记录（oracle）：断言从构造意图推导，不读实现中间量。 */
interface MaterialOracle {
  messages: ProbeMessage[]
  prefixFrom: number
  /** toolCall 下标 → 它的 toolResult 下标（工具批次原子性断言的唯一输入）。 */
  batches: { callIndex: number; resultIndexes: number[] }[]
}

/** 规划器实参的唯一装配点：`costOf` / `overhead` 只许读 `measureCompactionMaterial` 的产物。 */
function planOf(material: CompactionMaterial, messages: AgentMessage[]): CompactionShardPlan {
  return planCompactionShards({
    material: [...messages, ...material.turnPrefixMessages],
    turnPrefixFrom: messages.length,
    costOf: index => material.costs[index] ?? 0,
    overhead: material.overhead,
    sliceBudget: SLICE_BUDGET,
    hardInputLimit: BUDGET.hardInputLimit,
    maxSlices: MAX_COMPACTION_SLICES,
  })
}

/** 某条素材落在第几片（-1 = 没有被任何片覆盖，断言里单独报）。 */
function shardIndexOf(ranges: CompactionShardPlan["ranges"], index: number): number {
  return ranges.findIndex(([from, to]) => index >= from && index < to)
}

/**
 * 分片规划的六条不变式 + 工具批次原子性，唯一的判定点。
 *
 * 每条都从构造意图推导（oracle 的消息角色与 toolCall/结果下标），失败时给的是
 * 「哪一条不成立 + 现场」，而不是与实现算出的另一份数字对比。
 */
function assertShardPlanInvariants(label: string, oracle: MaterialOracle, plan: CompactionShardPlan): void {
  expect(plan.fatal, `${label}: 规划器给出 fatal=${JSON.stringify(plan.fatal)}，本用例应能规划出片`).toBeUndefined()
  const { ranges } = plan
  expect(ranges.length, `${label}: 规划器没有给出任何片（也没有 fatal）`).toBeGreaterThan(0)

  // ① 起点、连续、覆盖全量
  expect(ranges[0]![0], `${label}: 首片起点是 ${ranges[0]![0]}，应为 0`).toBe(0)
  for (let index = 1; index < ranges.length; index++) {
    expect(ranges[index]![0], `${label}: 片不连续 —— [${ranges[index - 1]!.join(",")}] 与 [${ranges[index]!.join(",")}] 之间有缝或重叠`)
      .toBe(ranges[index - 1]![1])
  }
  const lastRange = ranges[ranges.length - 1]!
  expect(lastRange[1], `${label}: 末片终点是 ${lastRange[1]}，素材长度是 ${oracle.messages.length}（未被全量覆盖）`)
    .toBe(oracle.messages.length)
  // ② 无空片
  for (const [from, to] of ranges) {
    expect(to, `${label}: 出现了空片 [${from},${to})`).toBeGreaterThan(from)
  }
  // ③ 没有任何片以 toolResult 开头（否则摘要模型会看到「没有调用的结果」）
  for (const [from] of ranges) {
    expect(oracle.messages[from]!.role, `${label}: 片起点 ${from} 落在 toolResult 上`).not.toBe("toolResult")
  }
  // ④ turnPrefixFrom 之后的内容只出现在最后一片。前缀单元永不切分、恒为最后一个单元，
  //    但允许与前面的普通素材同片 —— 所以判据是「除末片外没有片越过 prefixFrom」。
  for (let index = 0; index < ranges.length - 1; index++) {
    expect(ranges[index]![1], `${label}: 非末片 [${ranges[index]!.join(",")}] 越过 turnPrefixFrom=${oracle.prefixFrom}`)
      .toBeLessThanOrEqual(oracle.prefixFrom)
  }
  // ⑤ toolCall 与其 toolResult 永不同片（工具批次是不可分单元）
  for (const batch of oracle.batches) {
    const callShard = shardIndexOf(ranges, batch.callIndex)
    expect(callShard, `${label}: toolCall 下标 ${batch.callIndex} 没有被任何片覆盖`).toBeGreaterThanOrEqual(0)
    for (const index of batch.resultIndexes) {
      const resultShard = shardIndexOf(ranges, index)
      expect(resultShard, `${label}: toolCall ${batch.callIndex} 在片 #${callShard}，它的 toolResult ${index} 在片 #${resultShard}（调用与结果被拆开了）`)
        .toBe(callShard)
    }
  }
}

// ── 超硬上限素材（§1.4 的单元级版）──

interface OverHardLimitPayload {
  messages: AgentMessage[]
  material: CompactionMaterial
  plan: CompactionShardPlan
}

let cachedPayload: OverHardLimitPayload | undefined

/**
 * N 条满额 preserve 结果，每条是一个 assistant(toolCall) + toolResult 的**不可分单元**：
 * 素材总量超硬上限，而每个单元自身远低于硬上限 —— 分片可达，不是 oversized。
 */
function overHardLimitPayload(): OverHardLimitPayload {
  if (cachedPayload) return cachedPayload
  // 满额成本：`estimateContextTokens` 对 ASCII 计 4 字符 = 1 token，正文长度直接由 L0 预算推导。
  const result = "a".repeat(L0_TOKENS * 4)
  const count = Math.ceil(BUDGET.hardInputLimit / L0_TOKENS)
  const messages: ProbeMessage[] = []
  for (let index = 0; index < count; index++) {
    const callId = `shard-call-${index}`
    messages.push(assistantCall(callId, index * 2), toolResult(callId, result, index * 2 + 1, `shard-entry-${index}`))
  }
  const material = measureCompactionMaterial({
    messages: asMaterial(messages), window: WINDOW, preserveToolNames: PRESERVE_TOOL_NAMES,
  })
  cachedPayload = { messages: asMaterial(messages), material, plan: planOf(material, asMaterial(messages)) }
  return cachedPayload
}

/** 断言失败时带上真实口径，不让人从「未覆盖」反推载荷问题。 */
function sizing(material: CompactionMaterial, plan?: CompactionShardPlan): string {
  return `窗口 ${WINDOW}、hardInputLimit ${BUDGET.hardInputLimit}、单条 L0 ${L0_TOKENS}、sliceBudget ${SLICE_BUDGET}`
    + `、每条结果 ${L0_TOKENS * 4} 字符、素材 ${material.messages.length} 条消息 / used ${material.used} tokens`
    + `、overhead ${material.overhead}`
    + (plan === undefined ? "" : `、规划片数 ${plan.ranges.length}${plan.fatal ? `（fatal=${JSON.stringify(plan.fatal)}）` : ""}`)
}

// ── 摘要脚本（只替换 Provider，不跑真模型）──

/** 本片调用序号 → 一份可校验的结构化摘要；末片 intent 用来证明提交正文是末片产出。 */
const summaryText = (slice: number): string => JSON.stringify({
  intent: `第 ${slice} 片`, facts: [], corrections: [], pending: [], continuity: [], nextSteps: [],
})

/** 摘要请求脚本：记录真正发出去的素材正文，并按调用序号产出结构化摘要。 */
function summaryStep(requests: string[]): FauxResponseStep {
  return (context: Context, _options, state: FauxProviderState) => {
    const text = lastRequestText(context)
    expect(text, `摘要脚本被非摘要请求取走: ${text.slice(0, 60)}`).toContain("\"instructions\"")
    requests.push(text)
    return fakeText(summaryText(state.callCount))
  }
}

/** 抛错则返回错误对象，正常返回则 undefined —— 断言「必须抛」时用它取现场。 */
async function capture(work: () => Promise<unknown>): Promise<unknown | undefined> {
  try {
    await work()
    return undefined
  } catch (error) {
    return error
  }
}

describe("摘要分片规划", () => {
  it("摘要素材分片：规划不变式、超硬上限素材真分片、两类 fatal 明确失败 [memory-compaction-shard-plan]", async () => {
    // ── 载荷前提显式断言：超硬上限素材必须真的超硬上限，且必须规划得下（无 fatal、≥2 片、不超片数上限）──
    const payload = overHardLimitPayload()
    expect(payload.material.used, `场景载荷前提不成立：素材 ${payload.material.used} 未超硬上限 ${BUDGET.hardInputLimit}｜${sizing(payload.material, payload.plan)}`)
      .toBeGreaterThan(BUDGET.hardInputLimit)
    expect(payload.plan.fatal, `场景载荷前提不成立：超硬上限素材被判 fatal｜${sizing(payload.material, payload.plan)}`).toBeUndefined()
    expect(payload.plan.ranges.length, `场景载荷前提不成立：超硬上限素材只规划出 ${payload.plan.ranges.length} 片（分片没有真正发生）｜${sizing(payload.material, payload.plan)}`)
      .toBeGreaterThanOrEqual(2)
    expect(payload.plan.ranges.length, `场景载荷前提不成立：规划片数超出上限 ${MAX_COMPACTION_SLICES}｜${sizing(payload.material, payload.plan)}`)
      .toBeLessThanOrEqual(MAX_COMPACTION_SLICES)

    // ── ① 分片规划的不变式（合成视图）──
    // 合成视图：用户开轮 + 两个工具批次（批次 a 是「一条调用 → 两条结果」，批次 b 是单结果），
    // 其后是 in-progress 回合前缀（turnPrefixFrom 之后整体进最后一片）。
    //
    // 成本表（注入 costOf）配合 sliceBudget 99,483 的贪心轨迹（overhead 1,000）：
    //   [0,1) 60k 装片 1；批次 a 70k 装不下（131k）⇒ 封片，整批进片 2；
    //   [4,5) 10k 跟进片 2（81k）；批次 b 50k 装不下（131k）⇒ 封片，进片 3；
    //   前缀单元 50k 装不下（101k）⇒ 封片，进片 4。
    // 若按「逐条消息」装箱，批次 a 会在第 3 条结果处被切开 —— 这正是要挡的退化解。
    const costs = [60_000, 30_000, 20_000, 20_000, 10_000, 30_000, 20_000, 40_000, 10_000]
    const messages: ProbeMessage[] = [
      userMessage("第一轮用户输入。", 0),
      assistantCall("call-a", 1),
      toolResult("call-a", "结果 a1", 2),
      toolResult("call-a", "结果 a2", 3),
      userMessage("第二轮用户输入。", 4),
      assistantCall("call-b", 5),
      toolResult("call-b", "结果 b1", 6),
      userMessage("第三轮（进行中）", 7),
      assistantCall("call-c", 8),
    ]
    const plan = planCompactionShards({
      material: asMaterial(messages),
      turnPrefixFrom: 7,
      costOf: index => costs[index] ?? 0,
      overhead: 1_000,
      sliceBudget: SLICE_BUDGET,
      hardInputLimit: BUDGET.hardInputLimit,
      maxSlices: MAX_COMPACTION_SLICES,
    })
    assertShardPlanInvariants("合成批次视图", {
      messages, prefixFrom: 7,
      batches: [{ callIndex: 1, resultIndexes: [2, 3] }, { callIndex: 5, resultIndexes: [6] }],
    }, plan)
    // 非退化：这条载荷必须真的被分成多片（单片也能过上面几条断言）。
    expect(plan.ranges.length, `合成载荷只规划出 ${plan.ranges.length} 片，不变式断言没有触到分片路径`).toBeGreaterThanOrEqual(2)

    // ② 的防御路径：孤立 toolResult（toolCallId 与前面的 assistant 不配对）并入前一个单元 ——
    //    规划器不得因此让任何片以 toolResult 开头。素材首条就是 toolResult 属上游切点保证不会
    //    发生的输入（下标 0 没有前一个单元可并），不在这里构造。
    //    成本取 floor(sliceBudget / 3)：三个消息的合并单元恰好占满一片（不超硬上限 ⇒ 不是 oversized），
    //    而它与相邻单元同片必超 ⇒ 封片点落在单元边界上，孤立结果只能落在片内。
    const defensiveCost = Math.floor(SLICE_BUDGET / 3)
    const defensive: ProbeMessage[] = [
      userMessage("用户输入。", 0),
      assistantCall("call-m", 1),
      toolResult("call-m", "配对结果", 2),
      toolResult("call-n", "孤立结果", 3),
      userMessage("下一条用户输入。", 4),
    ]
    const defensivePlan = planCompactionShards({
      material: asMaterial(defensive),
      turnPrefixFrom: defensive.length,
      costOf: () => defensiveCost,
      overhead: 0,
      sliceBudget: SLICE_BUDGET,
      hardInputLimit: BUDGET.hardInputLimit,
      maxSlices: MAX_COMPACTION_SLICES,
    })
    assertShardPlanInvariants("孤立结果并入前一单元", {
      messages: defensive, prefixFrom: defensive.length, batches: [{ callIndex: 1, resultIndexes: [2] }],
    }, defensivePlan)
    // 防御必须真的生效：孤立结果（下标 3）不得成为片起点（并入上一单元后它只可能在片内）。
    expect(defensivePlan.ranges.some(([from]) => from === 3), "孤立 toolResult 被当成了片的起点（防御路径失效）").toBe(false)

    // ── ② 超硬上限素材真的分片并产出摘要 ──
    const { messages: shardMessages, material, plan: shardPlan } = overHardLimitPayload()
    // ① 前提复核（开头已显式断言过一次）：素材真的超硬上限，且规划得下、真的分成多片。
    expect(material.used, `素材未超硬上限｜${sizing(material, shardPlan)}`).toBeGreaterThan(BUDGET.hardInputLimit)
    expect(shardPlan.fatal, `超硬上限素材被判 fatal｜${sizing(material, shardPlan)}`).toBeUndefined()
    expect(shardPlan.ranges.length, `超硬上限素材没有分片｜${sizing(material, shardPlan)}`).toBeGreaterThanOrEqual(2)
    expect(shardPlan.ranges.length, `规划片数超出上限｜${sizing(material, shardPlan)}`).toBeLessThanOrEqual(MAX_COMPACTION_SLICES)
    // ② 每片自身必须装得进硬上限：`overhead + Σ该片 costs`（T4.01 的构造性恒等）与 hardInputLimit 同量纲；
    //    否则第 1 片就会抛 ContextBudgetError，分片没有意义。
    for (const [from, to] of shardPlan.ranges) {
      let cost = material.overhead
      for (let index = from; index < to; index++) cost += material.costs[index] ?? 0
      expect(cost, `片 [${from},${to}) 自身 ${cost} tokens 超硬上限 ${BUDGET.hardInputLimit}｜${sizing(material, shardPlan)}`)
        .toBeLessThanOrEqual(BUDGET.hardInputLimit)
    }
    // ③ 驱动真实内核：K 片 ⇒ K 次串行调用 ⇒ 恰好一份 outcome（片数从同一份规划推导，不写死常数）。
    const requests: string[] = []
    const provider = installProvider(
      Array.from({ length: shardPlan.ranges.length }, () => summaryStep(requests)), FAKE_MODEL,
    )
    const outcome = await summarizeCompaction({
      messages: shardMessages, model: provider.model, preserveToolNames: PRESERVE_TOOL_NAMES,
    })
    expect(provider.state.callCount, `摘要调用次数 ${provider.state.callCount} 与规划片数 ${shardPlan.ranges.length} 不一致`)
      .toBe(shardPlan.ranges.length)
    expect(requests.length, `摘要请求数 ${requests.length} 与规划片数 ${shardPlan.ranges.length} 不一致`).toBe(shardPlan.ranges.length)
    // ④ 正文必须来自唯一的解析+格式化链路，且内容就是末片脚本（不是透传、不是通用摘要、不是第一片的产出）。
    //    期望值取**场景脚本自己写的正文**（独立见证），不再用 `format(parse(同一段正文))`
    //    —— 那样两边同源，解析/格式化改坏会两边一起变。
    const scripted = parseStructuredSummary(summaryText(shardPlan.ranges.length))
    expect(scripted, "场景脚本生成的摘要不可解析（脚本自身有问题）").toBeDefined()
    const scriptedObject = JSON.parse(summaryText(shardPlan.ranges.length)) as unknown
    expect(outcome.summary, "提交摘要不是末片脚本正文的解析结果").toEqual(scriptedObject)
    expect(outcome.text, `提交正文不含末片脚本正文：${outcome.text.slice(0, 80)}`).toContain(summaryText(shardPlan.ranges.length))
    expect(outcome.text, "提交正文是原样透传的脚本正文（没有经过格式化包装）").not.toBe(summaryText(shardPlan.ranges.length))
    // 格式化包装与 summary 同源（两个输出字段不许各说各话）。
    expect(outcome.text).toBe(formatStructuredSummary(outcome.summary))
    expect(outcome.summary.intent, `提交正文不是末片产出：intent=${outcome.summary.intent}，应有 ${shardPlan.ranges.length} 片`)
      .toBe(`第 ${shardPlan.ranges.length} 片`)

    // ── ③ 片数超上限与不可分单元超限：两类 fatal ──
    // over_cap **只由纯函数驱动**（注入 costOf）：经 summarizeCompaction 真触发 over_cap 需要
    // 素材 > MAX_COMPACTION_SLICES × sliceBudget ≈ 796k tokens（≈3.2M ASCII 字符）。
    // 三组形态（含 needed ≠ 素材条数）都要命中真实片数。
    const shapes = [
      { units: MAX_COMPACTION_SLICES + 1, unitCost: SLICE_BUDGET },
      { units: MAX_COMPACTION_SLICES + 4, unitCost: SLICE_BUDGET },
      { units: MAX_COMPACTION_SLICES * 2 + 1, unitCost: Math.floor(SLICE_BUDGET / 2) },
    ]
    for (const shape of shapes) {
      // 单元同价、overhead 0 ⇒ 每片恰好装 floor(sliceBudget / unitCost) 个单元，真实片数 = ceil(单元数 / 每片单元数)。
      const perShard = Math.floor(SLICE_BUDGET / shape.unitCost)
      const expected = Math.ceil(shape.units / perShard)
      expect(expected, `场景夹具算错了：期望片数 ${expected} 未超过上限 ${MAX_COMPACTION_SLICES}`).toBeGreaterThan(MAX_COMPACTION_SLICES)
      const overCapMessages = Array.from({ length: shape.units }, (_, index) => userMessage(`第 ${index + 1} 条。`, index))
      const overCapPlan = planCompactionShards({
        material: asMaterial(overCapMessages),
        turnPrefixFrom: overCapMessages.length,
        costOf: () => shape.unitCost,
        overhead: 0,
        sliceBudget: SLICE_BUDGET,
        hardInputLimit: BUDGET.hardInputLimit,
        maxSlices: MAX_COMPACTION_SLICES,
      })
      // fatal 存在时 ranges 恒为 []（T4.00 交接）：判片数先判 fatal，真实片数读 fatal.needed。
      const overCapFatal = overCapPlan.fatal
      expect(overCapPlan.ranges.length, `over_cap 时 ranges 应为空，实际 ${overCapPlan.ranges.length} 片`).toBe(0)
      expect(overCapFatal?.reason, `片数超上限没有判 over_cap：${JSON.stringify(overCapFatal)}`).toBe("over_cap")
      expect(overCapFatal?.needed, `fatal.needed=${overCapFatal?.needed} 不是贪心装箱的真实片数 ${expected}`).toBe(expected)
      expect(overCapFatal?.used, `over_cap 的 used/limit 口径漂了：${JSON.stringify(overCapFatal)}`).toBe(MAX_COMPACTION_SLICES)
      expect(overCapFatal?.limit).toBe(MAX_COMPACTION_SLICES)
    }
    // 边界：「超过上限」是严格大于 —— 恰好 MAX_COMPACTION_SLICES 片不 fatal。
    const atCap = Array.from({ length: MAX_COMPACTION_SLICES }, (_, index) => userMessage(`第 ${index + 1} 条。`, index))
    const atCapPlan = planCompactionShards({
      material: asMaterial(atCap),
      turnPrefixFrom: atCap.length,
      costOf: () => SLICE_BUDGET,
      overhead: 0,
      sliceBudget: SLICE_BUDGET,
      hardInputLimit: BUDGET.hardInputLimit,
      maxSlices: MAX_COMPACTION_SLICES,
    })
    expect(atCapPlan.fatal, `恰好 ${MAX_COMPACTION_SLICES} 片被判 fatal：${JSON.stringify(atCapPlan.fatal)}`).toBeUndefined()
    expect(atCapPlan.ranges.length, `恰好 ${MAX_COMPACTION_SLICES} 片时实际规划出 ${atCapPlan.ranges.length} 片`).toBe(MAX_COMPACTION_SLICES)

    // oversized_unit：单个不可再分单元（一条用户消息）自身超硬上限 —— 不可再分，只能整次失败。
    // 正文长度由预算推导：ASCII 4 字符 ≈ 1 token，取 1.2 倍余量（wrapper/overhead 另计）。
    const oversizedMessages = [userMessage("a".repeat(Math.ceil(BUDGET.hardInputLimit * 4 * 1.2)), 0)]
    const oversizedMaterial = measureCompactionMaterial({ messages: asMaterial(oversizedMessages), window: WINDOW })
    expect(oversizedMaterial.used, `oversized 夹具没踩在硬上限上：used=${oversizedMaterial.used} vs ${BUDGET.hardInputLimit}`)
      .toBeGreaterThan(BUDGET.hardInputLimit)
    const oversizedPlan = planOf(oversizedMaterial, asMaterial(oversizedMessages))
    const oversizedFatal = oversizedPlan.fatal
    expect(oversizedPlan.ranges.length, `oversized_unit 时 ranges 应为空，实际 ${oversizedPlan.ranges.length} 片`).toBe(0)
    expect(oversizedFatal?.reason, `单单元超硬上限没有判 oversized_unit：${JSON.stringify(oversizedFatal)}`).toBe("oversized_unit")
    // T4.00 交接的数值口径：used = 单元成本 + overhead（与 hardInputLimit 同量纲）、limit = hardInputLimit、
    // needed = ceil(used / sliceBudget)。全部由同一份度量的产物推导，不写死数字。
    const unitCost = (oversizedMaterial.costs[0] ?? 0) + oversizedMaterial.overhead
    expect(oversizedFatal?.used, `oversized 的 used=${oversizedFatal?.used} ≠ 单元成本+overhead=${unitCost}`).toBe(unitCost)
    expect(oversizedFatal?.limit, `oversized 的 limit=${oversizedFatal?.limit} ≠ hardInputLimit=${BUDGET.hardInputLimit}`)
      .toBe(BUDGET.hardInputLimit)
    expect(oversizedFatal?.needed, `oversized 的 needed=${oversizedFatal?.needed} ≠ ceil(used/sliceBudget)=${Math.ceil(unitCost / SLICE_BUDGET)}`)
      .toBe(Math.ceil(unitCost / SLICE_BUDGET))

    // 失败可归因（B-3）：summarizeCompaction 在这份输入上抛 CompactionOverflowError，
    // 并且**一个摘要请求都不发**（空脚本的 fake provider 一旦被调用也会立刻失败）。
    const emptyProvider = installProvider([], FAKE_MODEL)
    const failure = await capture(() => summarizeCompaction({
      messages: asMaterial(oversizedMessages), model: emptyProvider.model,
    }))
    expect(failure, "oversized 素材没有抛错，返回了结果").toBeDefined()
    expect(failure instanceof CompactionOverflowError, `oversized 素材抛的不是 CompactionOverflowError：${formatError(failure)}`).toBe(true)
    expect((failure as CompactionOverflowError).code, "失败类型码不是 COMPACTION_MATERIAL_OVER_CAP").toBe("COMPACTION_MATERIAL_OVER_CAP")
    expect((failure as CompactionOverflowError).detail.reason, "失败原因不是 oversized_unit").toBe("oversized_unit")
    expect(emptyProvider.state.callCount, `失败路径发出了 ${emptyProvider.state.callCount} 次摘要请求（应为零请求）`).toBe(0)

    // ── ④ 绝不回退到上游通用摘要 ──
    // X-4 的 W4 侧回归：内核的每个注入故障都**抛出**，绝不返回一个通用摘要
    // （上游一旦拿到非 decline、非 compaction 的返回就走它自己的英文摘要，那条路径不可回滚）。
    // 故障都注入在**末片**：前面的片已经成功，若内核交出半成品就等于部分覆盖。
    const slices = shardPlan.ranges.length
    expect(slices, `本用例需要末片可失败的多片载荷，实际 ${slices} 片｜${sizing(material, shardPlan)}`).toBeGreaterThanOrEqual(2)

    const drive = async (script: FauxResponseStep[]): Promise<{
      provider: ReturnType<typeof installFakeProvider>
      /** 内核返回了结果（本用例里出现它就等于 X-4 回归）。 */
      returned?: true
      failure?: unknown
    }> => {
      const driveProvider = installProvider(script, FAKE_MODEL)
      const driveFailure = await capture(() => summarizeCompaction({
        messages: shardMessages, model: driveProvider.model, preserveToolNames: PRESERVE_TOOL_NAMES,
      }))
      return driveFailure === undefined ? { provider: driveProvider, returned: true } : { provider: driveProvider, failure: driveFailure }
    }
    /** 前 slices − 1 片正常返回，末片用注入故障：证明「已成功的前片」不会被当成半成品交出去。 */
    const lastSliceFault = (fault: FauxResponseStep): FauxResponseStep[] =>
      [...Array.from({ length: slices - 1 }, (_, index) => fakeText(summaryText(index + 1))), fault]

    // ① 坏 JSON：解析失败 ⇒ 抛「摘要格式无效」（不透传正文，也不落通用摘要）。
    const bad = await drive(lastSliceFault(fakeText("这不是 JSON")))
    expect(bad.returned, "坏 JSON 没有抛错，返回了结果").toBeUndefined()
    expect(bad.provider.state.callCount, `坏 JSON 用例的调用次数是 ${bad.provider.state.callCount}，应有 ${slices} 片`).toBe(slices)
    expect(formatError(bad.failure), `坏 JSON 的失败原因不是「摘要格式无效」：${formatError(bad.failure)}`).toContain("摘要格式无效")

    // ② 摘要超过 summaryMaxTokens：预算校验失败 ⇒ 抛「摘要超过预算上限」。
    const oversizedSummary = JSON.stringify({
      intent: "超预算摘要", facts: ["a".repeat(BUDGET.summaryMaxTokens * 8)],
      corrections: [], pending: [], continuity: [], nextSteps: [],
    })
    const parsedOversized = parseStructuredSummary(oversizedSummary)
    expect(parsedOversized, "超预算摘要夹具不可解析").toBeDefined()
    expect(estimateValueTokens(parsedOversized), `超预算摘要夹具没踩在 summaryMaxTokens=${BUDGET.summaryMaxTokens} 上`)
      .toBeGreaterThan(BUDGET.summaryMaxTokens)
    const fat = await drive(lastSliceFault(fakeText(oversizedSummary)))
    expect(fat.returned, "超预算摘要没有抛错，返回了结果").toBeUndefined()
    expect(fat.provider.state.callCount, `超预算摘要用例的调用次数是 ${fat.provider.state.callCount}，应有 ${slices} 片`).toBe(slices)
    expect(formatError(fat.failure), `超预算摘要的失败原因不是「摘要超过预算上限」：${formatError(fat.failure)}`)
      .toContain("摘要超过预算上限")

    // ③ 中途取消：末片请求在飞时 abort ⇒ 抛错（逐片 signal 透传与片间取消检查是同一条取消链），
    //    不把已作废的结果交出去。文案取网关的取消分支（model-gateway.ts 的 abort 文案）。
    const controller = new AbortController()
    const abortingStep: FauxResponseStep = () => {
      controller.abort()
      return fakeText(summaryText(slices))
    }
    const abortProvider = installProvider(lastSliceFault(abortingStep), FAKE_MODEL)
    const aborted = await capture(() => summarizeCompaction({
      messages: shardMessages, model: abortProvider.model, preserveToolNames: PRESERVE_TOOL_NAMES, signal: controller.signal,
    }))
    expect(aborted, "取消没有抛错，返回了结果").toBeDefined()
    expect(abortProvider.state.callCount, `取消失例的调用次数是 ${abortProvider.state.callCount}（应有 ${slices} 片：取消须发生在片间中段，而不是第一片前）`)
      .toBe(slices)
    expect(formatError(aborted), `取消的失败原因不是取消文案：${formatError(aborted)}`).toContain("取消")
  })
})
