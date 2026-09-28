import type { Context, FauxModelDefinition, FauxProviderState, FauxResponseStep } from "@earendil-works/pi-ai"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
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
import { fakeText, installFakeProvider, lastRequestText } from "../../fake-provider"
import type { SceneDef } from "../../types"

// ==========================================
// W4 问题 B 的内核侧：分片规划器的不变式 + 超硬上限素材确实分片产出摘要 + 片数超上限明确失败
//
// 本场景证的是**内核与规划器**（`planCompactionShards` / `measureCompactionMaterial` /
// `summarizeCompaction`）：只调纯函数与被导出的内核入口，fake provider 只替换 Provider、
// 不跑真模型、不建会话。真实链路（production 入口 + preserve 载荷的逐片迭代）见 `压缩分片` 场景。
//
// 三条交接口径先写在最前，防止后来者按直觉读错：
//
// 1. **`fatal` 存在时 `ranges` 恒为 `[]`**（T4.00 的返回形态）。判「有没有可规划对象」必须
//    先判 `fatal` 再判 `ranges.length`；反过来读会把「片数超上限」误判成「没有可分对象」。
//    要断言真实片数请读 `fatal.needed` —— 它是贪心装箱数出来的片数，不是估算常数。
// 2. **`overhead + Σcosts === used` 是构造性恒等**（T4.01：`overhead` 的定义即 `used − Σcosts`）。
//    因此「片上成本」`overhead + Σ该片 costs` 与 `hardInputLimit` 同量纲，可以直接与硬上限比较；
//    本场景的每片可发断言与 oversized 判据都从这条恒等式推导，不另建第二份口径。
// 3. **预算数字一律运行期口径**：`contextBudget(window)`（**不传 `maxOutput`**）＋
//    `toolResultTokenBudget(window)`。hardInputLimit / 单条 L0 / sliceBudget / 片数上限
//    全部由这两个函数与 `COMPACTION_SLICE_RATIO` / `MAX_COMPACTION_SLICES` 推导，
//    场景不复制任何字面量（改预算只该改实现一处）。
//
// 载荷构造用源方案 §1.4 的可执行版：`N = ceil(hardInputLimit / L0 满额成本)`（128k 窗口 → 12），
// 且结果一律 `resultProjection=preserve` —— T4.03 之后素材投影会先按级 0→1→2 升档，非 preserve
// 的长结果会被缩短/清空（素材自己就小下去，永远到不了第二层）；preserve 全程停在级 0
// （preserve 的结果禁止二次处理），分片因此是它的唯一出路。前提在 setup 里显式失败，
// 不让断言在错误载荷上空转（同 `压缩降级` 的 assertPayloadPremise）。
// ==========================================

/** 运行期窗口口径（`contextBudget` 的默认窗口）：不读本机 CONFIG，避免 Live 配置漂移。 */
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
 * T4.00 步骤 4 的六条不变式 + 工具批次原子性，唯一的判定点。
 *
 * 每条都从构造意图推导（oracle 的消息角色与 toolCall/结果下标），失败时给的是
 * 「哪一条不成立 + 现场」，而不是与实现算出的另一份数字对比。
 */
function assertShardPlanInvariants(label: string, oracle: MaterialOracle, plan: CompactionShardPlan): void {
  if (plan.fatal) throw new Error(`${label}: 规划器给出 fatal=${JSON.stringify(plan.fatal)}，本用例应能规划出片`)
  const { ranges } = plan
  if (ranges.length === 0) throw new Error(`${label}: 规划器没有给出任何片（也没有 fatal）`)

  // ① 起点、连续、覆盖全量
  if (ranges[0]![0] !== 0) throw new Error(`${label}: 首片起点是 ${ranges[0]![0]}，应为 0`)
  for (let index = 1; index < ranges.length; index++) {
    if (ranges[index]![0] !== ranges[index - 1]![1]) {
      throw new Error(`${label}: 片不连续 —— [${ranges[index - 1]!.join(",")}] 与 [${ranges[index]!.join(",")}] 之间有缝或重叠`)
    }
  }
  const lastRange = ranges[ranges.length - 1]!
  if (lastRange[1] !== oracle.messages.length) {
    throw new Error(`${label}: 末片终点是 ${lastRange[1]}，素材长度是 ${oracle.messages.length}（未被全量覆盖）`)
  }
  // ② 无空片
  for (const [from, to] of ranges) {
    if (to <= from) throw new Error(`${label}: 出现了空片 [${from},${to})`)
  }
  // ③ 没有任何片以 toolResult 开头（否则摘要模型会看到「没有调用的结果」）
  for (const [from] of ranges) {
    if (oracle.messages[from]!.role === "toolResult") {
      throw new Error(`${label}: 片起点 ${from} 落在 toolResult 上`)
    }
  }
  // ④ turnPrefixFrom 之后的内容只出现在最后一片。前缀单元永不切分、恒为最后一个单元，
  //    但允许与前面的普通素材同片 —— 所以判据是「除末片外没有片越过 prefixFrom」。
  for (let index = 0; index < ranges.length - 1; index++) {
    if (ranges[index]![1] > oracle.prefixFrom) {
      throw new Error(`${label}: 非末片 [${ranges[index]!.join(",")}] 越过 turnPrefixFrom=${oracle.prefixFrom}`)
    }
  }
  // ⑤ toolCall 与其 toolResult 永不同片（工具批次是不可分单元）
  for (const batch of oracle.batches) {
    const callShard = shardIndexOf(ranges, batch.callIndex)
    if (callShard < 0) throw new Error(`${label}: toolCall 下标 ${batch.callIndex} 没有被任何片覆盖`)
    for (const index of batch.resultIndexes) {
      const resultShard = shardIndexOf(ranges, index)
      if (resultShard !== callShard) {
        throw new Error(`${label}: toolCall ${batch.callIndex} 在片 #${callShard}，`
          + `它的 toolResult ${index} 在片 #${resultShard}（调用与结果被拆开了）`)
      }
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
    if (!text.includes("\"instructions\"")) throw new Error(`摘要脚本被非摘要请求取走: ${text.slice(0, 60)}`)
    requests.push(text)
    return fakeText(summaryText(state.callCount))
  }
}

/** 抛错则返回错误对象，正常返回则 undefined —— 断言「必须抛」时用它取现场。 */
async function rejection(work: () => Promise<unknown>): Promise<unknown | undefined> {
  try {
    await work()
    return undefined
  } catch (error) {
    return error
  }
}

export const 摘要分片规划: SceneDef = {
  meta: {
    caseId: "memory-compaction-shard-plan",
    module: "memory",
    contractId: "mm-33",
    description: "摘要素材分片：规划器六条不变式（工具批次原子性、turnPrefix 只在末片、无片以 toolResult 开头）、超硬上限素材真的分片并产出摘要、片数超上限与不可分单元超限都明确失败",
    depth: "deep",
    suite: "regression",
    entry: "unit",
    tags: ["memory", "compaction", "boundary", "error"],
  },
  setup: async () => {
    // 载荷前提显式失败：超硬上限素材必须真的超硬上限，且必须规划得下（无 fatal、≥2 片、不超片数上限）——
    // 前提不成立时直接给出可读原因，不让断言去猜。
    const { material, plan } = overHardLimitPayload()
    if (!(material.used > BUDGET.hardInputLimit)) {
      throw new Error(`场景载荷前提不成立：素材 ${material.used} 未超硬上限 ${BUDGET.hardInputLimit}｜${sizing(material, plan)}`)
    }
    if (plan.fatal) throw new Error(`场景载荷前提不成立：超硬上限素材被判 fatal｜${sizing(material, plan)}`)
    if (plan.ranges.length < 2) {
      throw new Error(`场景载荷前提不成立：超硬上限素材只规划出 ${plan.ranges.length} 片（分片没有真正发生）｜${sizing(material, plan)}`)
    }
    if (plan.ranges.length > MAX_COMPACTION_SLICES) {
      throw new Error(`场景载荷前提不成立：规划片数 ${plan.ranges.length} 超出上限 ${MAX_COMPACTION_SLICES}｜${sizing(material, plan)}`)
    }
  },
  turns: [{
    index: 1,
    description: "核对分片规划的不变式、超硬上限素材的分片产出、两类 fatal 与摘要内核的失败可归因",
    userText: "核对摘要分片规划与上限失败。",
    checks: [
      { type: "expectShardPlanInvariants", run: async () => {
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
        if (plan.ranges.length < 2) {
          throw new Error(`合成载荷只规划出 ${plan.ranges.length} 片，不变式断言没有触到分片路径`)
        }

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
        if (defensivePlan.ranges.some(([from]) => from === 3)) {
          throw new Error("孤立 toolResult 被当成了片的起点（防御路径失效）")
        }
      } },

      { type: "expectOverHardLimitMaterialShards", run: async () => {
        const { messages, material, plan } = overHardLimitPayload()
        // ① 前提复核（setup 已显式失败过一次）：素材真的超硬上限，且规划得下、真的分成多片。
        if (!(material.used > BUDGET.hardInputLimit)) throw new Error(`素材未超硬上限｜${sizing(material, plan)}`)
        if (plan.fatal) throw new Error(`超硬上限素材被判 fatal｜${sizing(material, plan)}`)
        if (plan.ranges.length < 2) throw new Error(`超硬上限素材没有分片｜${sizing(material, plan)}`)
        if (plan.ranges.length > MAX_COMPACTION_SLICES) throw new Error(`规划片数超出上限｜${sizing(material, plan)}`)
        // ② 每片自身必须装得进硬上限：`overhead + Σ该片 costs`（T4.01 的构造性恒等）与 hardInputLimit 同量纲；
        //    否则第 1 片就会抛 ContextBudgetError，分片没有意义。
        for (const [from, to] of plan.ranges) {
          let cost = material.overhead
          for (let index = from; index < to; index++) cost += material.costs[index] ?? 0
          if (cost > BUDGET.hardInputLimit) {
            throw new Error(`片 [${from},${to}) 自身 ${cost} tokens 超硬上限 ${BUDGET.hardInputLimit}｜${sizing(material, plan)}`)
          }
        }
        // ③ 驱动真实内核：K 片 ⇒ K 次串行调用 ⇒ 恰好一份 outcome（片数从同一份规划推导，不写死常数）。
        const requests: string[] = []
        const provider = installFakeProvider(
          Array.from({ length: plan.ranges.length }, () => summaryStep(requests)), FAKE_MODEL,
        )
        const outcome = await summarizeCompaction({
          messages, model: provider.model, preserveToolNames: PRESERVE_TOOL_NAMES,
        })
        if (provider.state.callCount !== plan.ranges.length) {
          throw new Error(`摘要调用次数 ${provider.state.callCount} 与规划片数 ${plan.ranges.length} 不一致`)
        }
        if (requests.length !== plan.ranges.length) {
          throw new Error(`摘要请求数 ${requests.length} 与规划片数 ${plan.ranges.length} 不一致`)
        }
        // ④ 正文必须来自唯一的解析+格式化链路：末片脚本正文 → parseStructuredSummary → formatStructuredSummary，
        //    与 `CompactionSummaryOutcome.text` 逐字相同（不是透传、不是通用摘要、不是第一片的产出）。
        const scripted = parseStructuredSummary(summaryText(requests.length))
        if (!scripted) throw new Error("场景脚本生成的摘要不可解析（脚本自身有问题）")
        if (outcome.text !== formatStructuredSummary(scripted)) {
          throw new Error(`提交正文不是 formatStructuredSummary(parseStructuredSummary(...)) 的产出：${outcome.text.slice(0, 80)}`)
        }
        if (outcome.text !== formatStructuredSummary(outcome.summary)) {
          throw new Error("CompactionSummaryOutcome.text 与 summary 不同源")
        }
        if (outcome.summary.intent !== `第 ${plan.ranges.length} 片`) {
          throw new Error(`提交正文不是末片产出：intent=${outcome.summary.intent}，应有 ${plan.ranges.length} 片`)
        }
      } },

      { type: "expectShardOverCap", run: async () => {
        // ① over_cap **只由纯函数驱动**（注入 costOf）：经 summarizeCompaction 真触发 over_cap 需要
        //    素材 > MAX_COMPACTION_SLICES × sliceBudget ≈ 796k tokens（≈3.2M ASCII 字符），
        //    与 unit 场景的 10s 上限不成比例。三组形态（含 needed ≠ 素材条数）都要命中真实片数。
        const shapes = [
          { units: MAX_COMPACTION_SLICES + 1, unitCost: SLICE_BUDGET },
          { units: MAX_COMPACTION_SLICES + 4, unitCost: SLICE_BUDGET },
          { units: MAX_COMPACTION_SLICES * 2 + 1, unitCost: Math.floor(SLICE_BUDGET / 2) },
        ]
        for (const shape of shapes) {
          // 单元同价、overhead 0 ⇒ 每片恰好装 floor(sliceBudget / unitCost) 个单元，真实片数 = ceil(单元数 / 每片单元数)。
          const perShard = Math.floor(SLICE_BUDGET / shape.unitCost)
          const expected = Math.ceil(shape.units / perShard)
          if (expected <= MAX_COMPACTION_SLICES) {
            throw new Error(`场景夹具算错了：期望片数 ${expected} 未超过上限 ${MAX_COMPACTION_SLICES}`)
          }
          const messages = Array.from({ length: shape.units }, (_, index) => userMessage(`第 ${index + 1} 条。`, index))
          const plan = planCompactionShards({
            material: asMaterial(messages),
            turnPrefixFrom: messages.length,
            costOf: () => shape.unitCost,
            overhead: 0,
            sliceBudget: SLICE_BUDGET,
            hardInputLimit: BUDGET.hardInputLimit,
            maxSlices: MAX_COMPACTION_SLICES,
          })
          // fatal 存在时 ranges 恒为 []（T4.00 交接）：判片数先判 fatal，真实片数读 fatal.needed。
          if (plan.ranges.length !== 0) throw new Error(`over_cap 时 ranges 应为空，实际 ${plan.ranges.length} 片`)
          if (plan.fatal?.reason !== "over_cap") throw new Error(`片数超上限没有判 over_cap：${JSON.stringify(plan.fatal)}`)
          if (plan.fatal.needed !== expected) {
            throw new Error(`fatal.needed=${plan.fatal.needed} 不是贪心装箱的真实片数 ${expected}`)
          }
          if (plan.fatal.used !== MAX_COMPACTION_SLICES || plan.fatal.limit !== MAX_COMPACTION_SLICES) {
            throw new Error(`over_cap 的 used/limit 口径漂了：${JSON.stringify(plan.fatal)}`)
          }
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
        if (atCapPlan.fatal !== undefined) throw new Error(`恰好 ${MAX_COMPACTION_SLICES} 片被判 fatal：${JSON.stringify(atCapPlan.fatal)}`)
        if (atCapPlan.ranges.length !== MAX_COMPACTION_SLICES) {
          throw new Error(`恰好 ${MAX_COMPACTION_SLICES} 片时实际规划出 ${atCapPlan.ranges.length} 片`)
        }

        // ② oversized_unit：单个不可再分单元（一条用户消息）自身超硬上限 —— 不可再分，只能整次失败。
        //    正文长度由预算推导：ASCII 4 字符 ≈ 1 token，取 1.2 倍余量（wrapper/overhead 另计）。
        const oversizedMessages = [userMessage("a".repeat(Math.ceil(BUDGET.hardInputLimit * 4 * 1.2)), 0)]
        const oversizedMaterial = measureCompactionMaterial({ messages: asMaterial(oversizedMessages), window: WINDOW })
        if (!(oversizedMaterial.used > BUDGET.hardInputLimit)) {
          throw new Error(`oversized 夹具没踩在硬上限上：used=${oversizedMaterial.used} vs ${BUDGET.hardInputLimit}`)
        }
        const oversizedPlan = planOf(oversizedMaterial, asMaterial(oversizedMessages))
        if (oversizedPlan.ranges.length !== 0) {
          throw new Error(`oversized_unit 时 ranges 应为空，实际 ${oversizedPlan.ranges.length} 片`)
        }
        if (oversizedPlan.fatal?.reason !== "oversized_unit") {
          throw new Error(`单单元超硬上限没有判 oversized_unit：${JSON.stringify(oversizedPlan.fatal)}`)
        }
        // T4.00 交接的数值口径：used = 单元成本 + overhead（与 hardInputLimit 同量纲）、limit = hardInputLimit、
        // needed = ceil(used / sliceBudget)。全部由同一份度量的产物推导，不写死数字。
        const unitCost = (oversizedMaterial.costs[0] ?? 0) + oversizedMaterial.overhead
        if (oversizedPlan.fatal.used !== unitCost) {
          throw new Error(`oversized 的 used=${oversizedPlan.fatal.used} ≠ 单元成本+overhead=${unitCost}`)
        }
        if (oversizedPlan.fatal.limit !== BUDGET.hardInputLimit) {
          throw new Error(`oversized 的 limit=${oversizedPlan.fatal.limit} ≠ hardInputLimit=${BUDGET.hardInputLimit}`)
        }
        if (oversizedPlan.fatal.needed !== Math.ceil(unitCost / SLICE_BUDGET)) {
          throw new Error(`oversized 的 needed=${oversizedPlan.fatal.needed} ≠ ceil(used/sliceBudget)=${Math.ceil(unitCost / SLICE_BUDGET)}`)
        }

        // ③ 失败可归因（B-3）：summarizeCompaction 在这份输入上抛 CompactionOverflowError，
        //    并且**一个摘要请求都不发**（空脚本的 fake provider 一旦被调用也会立刻失败）。
        const provider = installFakeProvider([], FAKE_MODEL)
        const failure = await rejection(() => summarizeCompaction({
          messages: asMaterial(oversizedMessages), model: provider.model,
        }))
        if (failure === undefined) throw new Error("oversized 素材没有抛错，返回了结果")
        if (!(failure instanceof CompactionOverflowError)) {
          throw new Error(`oversized 素材抛的不是 CompactionOverflowError：${formatError(failure)}`)
        }
        if (failure.code !== "COMPACTION_MATERIAL_OVER_CAP") {
          throw new Error(`失败类型码不是 COMPACTION_MATERIAL_OVER_CAP：${failure.code}`)
        }
        if (failure.detail.reason !== "oversized_unit") {
          throw new Error(`失败原因不是 oversized_unit：${failure.detail.reason}`)
        }
        if (provider.state.callCount !== 0) {
          throw new Error(`失败路径发出了 ${provider.state.callCount} 次摘要请求（应为零请求）`)
        }
      } },

      { type: "expectNeverFallsBackToUpstreamSummary", run: async () => {
        // X-4 的 W4 侧回归：内核的每个注入故障都**抛出**，绝不返回一个通用摘要
        // （上游一旦拿到非 decline、非 compaction 的返回就走它自己的英文摘要，那条路径不可回滚）。
        // 故障都注入在**末片**：前面的片已经成功，若内核交出半成品就等于部分覆盖。
        const { messages, material, plan } = overHardLimitPayload()
        if (plan.ranges.length < 2) {
          throw new Error(`本用例需要末片可失败的多片载荷，实际 ${plan.ranges.length} 片｜${sizing(material, plan)}`)
        }
        const slices = plan.ranges.length

        const drive = async (script: FauxResponseStep[]): Promise<{
          provider: ReturnType<typeof installFakeProvider>
          /** 内核返回了结果（本用例里出现它就等于 X-4 回归）。 */
          returned?: true
          failure?: unknown
        }> => {
          const provider = installFakeProvider(script, FAKE_MODEL)
          const failure = await rejection(() => summarizeCompaction({
            messages, model: provider.model, preserveToolNames: PRESERVE_TOOL_NAMES,
          }))
          return failure === undefined ? { provider, returned: true } : { provider, failure }
        }
        /** 前 slices − 1 片正常返回，末片用注入故障：证明「已成功的前片」不会被当成半成品交出去。 */
        const lastSliceFault = (fault: FauxResponseStep): FauxResponseStep[] =>
          [...Array.from({ length: slices - 1 }, (_, index) => fakeText(summaryText(index + 1))), fault]

        // ① 坏 JSON：解析失败 ⇒ 抛「摘要格式无效」（不透传正文，也不落通用摘要）。
        const bad = await drive(lastSliceFault(fakeText("这不是 JSON")))
        if (bad.returned) throw new Error("坏 JSON 没有抛错，返回了结果")
        if (bad.provider.state.callCount !== slices) {
          throw new Error(`坏 JSON 用例的调用次数是 ${bad.provider.state.callCount}，应有 ${slices} 片`)
        }
        if (!formatError(bad.failure).includes("摘要格式无效")) {
          throw new Error(`坏 JSON 的失败原因不是「摘要格式无效」：${formatError(bad.failure)}`)
        }

        // ② 摘要超过 summaryMaxTokens：预算校验失败 ⇒ 抛「摘要超过预算上限」。
        const oversizedSummary = JSON.stringify({
          intent: "超预算摘要", facts: ["a".repeat(BUDGET.summaryMaxTokens * 8)],
          corrections: [], pending: [], continuity: [], nextSteps: [],
        })
        const parsedOversized = parseStructuredSummary(oversizedSummary)
        if (!parsedOversized || estimateValueTokens(parsedOversized) <= BUDGET.summaryMaxTokens) {
          throw new Error(`超预算摘要夹具没踩在 summaryMaxTokens=${BUDGET.summaryMaxTokens} 上`)
        }
        const fat = await drive(lastSliceFault(fakeText(oversizedSummary)))
        if (fat.returned) throw new Error("超预算摘要没有抛错，返回了结果")
        if (fat.provider.state.callCount !== slices) {
          throw new Error(`超预算摘要用例的调用次数是 ${fat.provider.state.callCount}，应有 ${slices} 片`)
        }
        if (!formatError(fat.failure).includes("摘要超过预算上限")) {
          throw new Error(`超预算摘要的失败原因不是「摘要超过预算上限」：${formatError(fat.failure)}`)
        }

        // ③ 中途取消：末片请求在飞时 abort ⇒ 抛错（逐片 signal 透传与片间取消检查是同一条取消链），
        //    不把已作废的结果交出去。文案取网关的取消分支（model-gateway.ts 的 abort 文案）。
        const controller = new AbortController()
        const abortingStep: FauxResponseStep = () => {
          controller.abort()
          return fakeText(summaryText(slices))
        }
        const provider = installFakeProvider(lastSliceFault(abortingStep), FAKE_MODEL)
        const aborted = await rejection(() => summarizeCompaction({
          messages, model: provider.model, preserveToolNames: PRESERVE_TOOL_NAMES, signal: controller.signal,
        }))
        if (aborted === undefined) throw new Error("取消没有抛错，返回了结果")
        if (provider.state.callCount !== slices) {
          throw new Error(`取消失例的调用次数是 ${provider.state.callCount}（应有 ${slices} 片：取消须发生在片间中段，而不是第一片前）`)
        }
        if (!formatError(aborted).includes("取消")) {
          throw new Error(`取消的失败原因不是取消文案：${formatError(aborted)}`)
        }
      } },
    ],
  }],
}

export default 摘要分片规划
