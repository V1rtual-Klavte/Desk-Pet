import { prepareCompaction } from "@earendil-works/pi-agent-core"
import type { AgentMessage, CompactionPreparation, Entry } from "@earendil-works/pi-agent-core"
import type { Context, FauxModelDefinition, FauxResponseFactory, FauxResponseStep } from "@earendil-works/pi-ai"
import { contentText } from "@earendil-works/pi-ai"
import { formatStructuredSummary, parseStructuredSummary } from "@/services/engine/compaction/structured-summary"
import { initChat, sendMessage } from "@/services/agent/runner"
import { aiConfig } from "@/services/config"
import { contextBudget, estimateRequestTokens } from "@/services/context"
import { COMPACTION_SLICE_RATIO, MAX_COMPACTION_SLICES, measureCompactionMaterial } from "@/services/engine"
import type { CompactionMaterial } from "@/services/engine"
import { formatError } from "@/services/error"
import { compactActiveSession, compactionSettingsFor, harnessSlots } from "@/services/engine/harness"
import { getActiveSessionId } from "@/services/session"
import { TOOL_POLICY_VERSION, defineTool, getToolByName, register, unregister } from "@/services/tool"
import type { ToolDef } from "@/services/tool"
import { fakeText, fakeToolCall, installFakeProvider, lastRequestText } from "../../../host/fake-provider"
import { compactionEntries, sessionEntries } from "../../../host/session-entries"
import type { SceneDef } from "../../../e2e/types"

// ==========================================
// B-1 / B-2 / 问题 B 的生产场景：超硬上限的摘要素材**不 decline**，而是分片产出摘要并一次性提交
//
// 本场景证的是**真实链路的分片迭代**：`initChat` + 真实工具链路（探针真的执行、结果真的落盘）
// + 真实 `completePiText`（每片一次一次性请求）+ 真实 `before_compaction` 钩子 + 真实 compaction
// 条目提交（恰好一条、`fromHook`）。内核与规划器的 unit 面在 `摘要分片规划`（`mm-33`，
// caseId `memory-compaction-shard-plan`）—— 分片不变式、两类 fatal、X-4 都在那边，
// 本场景不重复规划器断言，只钉「生产入口上它真的这么跑」。轮 3/轮 4（同一 caseId：连续第二次
// 分片压缩与跨压缩迭代）由 T4.08 在本文件追加，见下面「跨压缩迭代（轮 3/轮 4）」一节。
//
// ── 载荷（源方案 §1.4 的可执行版，全部由预算常量推导）──
//
// 光靠正文体量到不了硬上限：主请求视图被宿主硬预算闸门封在 `hardInputLimit` 以内，摘要素材
// 是它的子集。真正可达的机制是**素材的 JSON 序列化放大**——`measureCompactionMaterial` 的估算
// 跑在 `JSON.stringify` 之后，ASCII 的双引号在正文里变成 `\"`，字符数翻倍，于是
// **素材成本 = 视图成本 × 2**（每条探针的素材 = 字符数 / 2、视图 = 字符数 / 4）。
// `resultProjection: "preserve"` 在此是必需条件：素材侧阶梯会把非 preserve 的长结果缩到单条
// 上限（≈10.4k tokens），第一层就消化掉了，永远到不了第二层 —— 这正是
// `expectPreserveGatesFirstLayer` 的一对断言。
//
// 用户轮 1 连续调用 preserve 探针两次（同参重复的软阈值是 3 次，两次不触发循环病理检测；
// 主回合已无计数上限）：
// 视图 ≈ 2 × PROBE_VIEW_TOKENS、素材 ≈ PROBE_CHARS > hardInputLimit，而每个工具批次
// （assistant + 其 toolResult）的素材只有 PROBE_CHARS / 2、低于单片预算 ⇒ 可分片、不是
// oversized_unit；两批合起来 PROBE_CHARS > 单片预算 ⇒ K ≥ 2 是构造性的。探针大小夹在
// 「素材侧下界 / 视图侧上界 / 会话文件字节」之间，取靠下界的 1/8 处（见 `PROBE_CHARS` 的推导）。
//
// ── 切点由哪条消息承载（实跑修正，2026-09-28）──
//
// 能分片的那部分素材必须是 `messagesToSummarize`：`turnPrefixFrom..end` 合成**永不切分**的
// 前缀单元（T4.00 的 prefixUnit），两段探针一旦落进去，合计 PROBE_CHARS / 2 × 2 就超硬上限
// ⇒ 规划直接返回 `fatal{oversized_unit}`。
//
// 上游 `findCutPoint`（`compaction.js` 的 253-294 行）从末尾回收 ≈`keepRecentTokens`：
// **从最后一条消息往回累加**，撞上哪条消息把累计顶过保留窗口，切点就取它（或其后的第一个
// 合法切点）；随后还有一段回退循环（`while (cutIndex > startIndex)`，遇非消息条目就前移）。
// 审计快照（`deskpet.prompt_snapshot`）落在每条助手消息之后（按回合 flush），所以：
// **让「用户正文」承载切点是坏铺法**（W6 首跑实测）：切点落在正文上后被回退循环推回
// 「上一条消息之后」⇒ 切点变成快照条目、`isSplitTurn = true`，回合起点成了**探针那一轮**的
// 用户消息：整轮（含两段探针）成前缀单元 ⇒ `不可再分的片段（约 146108 tokens）超过单片上限
// 124354`，手动压缩 failed。
//
// 现在由**该回合里的一条长工具结果**（`HOLD_RESULT`，轮 2 / 轮 4 各一条）承载：它是回合里
// 最后一条消息之外**唯一的**长消息，上游从末尾累加第一步就在它身上顶过保留窗口，切点随即落
// 在它的**后继助手消息**（回合收尾回复）上 —— 而那条回复前面正是这条结果是**消息**，
// 回退循环不再前移 ⇒ 该回合的前半段（正文 + toolCall + 这条结果）成前缀单元（永不切分，但
// 素材 ≈ HOLD_TOKENS，装得进单片预算），两段探针整体留在 `messagesToSummarize` 里。
// **承载量不能放在助手回复上**：助手消息走流式，每 ~16 字符一帧、实测 ≈248 字节/帧
// ⇒ 8.4 万字符的回复 ≈1.3 MB 只帧开销；工具结果不产生帧（见「会话文件字节账」）。
// 切点的真实形态不再由场景自己推导：每次断言前用上游真件 `prepareCompaction` 复核
// （`preparation()`），它是唯一重建点。
//
// ── 会话文件字节账（5 MiB 硬上限；W6 第二次实跑被它击穿）──
//
// 宿主临时数据根的会话 JSONL 有一条**整文件大小门**（Rust `file_read`：
// `metadata.len() > MAX_TOOL_FILE_BYTES` 直接报「文件过大」），上游读会话头也走它
// （`jsonl/repo.js` 的 `readTextLines(path, {maxLines: 1})`）⇒ 文件一旦越过 5 MiB，**整个模块**
// 的后续场景都会在 setup 失败（隔离重置要读会话头）。这不是本波引入的缺陷，修它不在本方案范围，
// 场景只能自己适配。逐项字节（每次 trial，按 harness 真实写入形态实测/折算）：
//
//   探针结果 ×4（两条一批 × 两批）  暂存 payload + 提交条目，各 2 × PROBE_CHARS 字节 ≈ 0.43 MiB
//   切点承载结果 ×2                  暂存 + 条目，各 HOLD_CHARS 字节                ≈ 0.16 MiB
//   助手流式帧                       回复都是短句 ⇒ 每回合 1–2 帧                    < 0.01 MiB
//   `pi.op.preparation` ×2           每次压缩一份、素材原样进盘（≈ 两条探针 + 承载结果）≈ 1.0 MiB
//   快照/状态/小条目/压缩条目        审计是哈希投影、不含正文（实测 09-24 会话量级）  ≈ 0.25 MiB
//   ────────────────────────────────────────────────────────────────────────  合计 ≈ 1.9 MiB
//
// 对照被击穿的旧形态：两条 84,000 字符的**助手回复**（各 ≈1.3 MB 帧）+ 两条 84,000 字符的
// **用户正文** + 更大的探针（145,528 字符）+ 更长的保留段进 `compaction` 条目
// ⇒ 实测越过 5 MiB。**改载荷时先按这张表算一遍**。
//
// ── 探针的对照声明与载荷口径 ──
//
// 注册两个探针（`preserve` 与 `reference`，结果同长度），**只调用 preserve 探针两次**：
// reference 结果会被 L0 缩短到单条上限（`toolResultTokenBudget`），既让素材不再是
// 「素材 = 2 × 视图」这个可推导的形态，又给请求视图多塞一份缩短后的正文 ——
// 而视图余量正是「阈值压缩不在回合内先发生」的余量。
// 「preserve 让第一层无效、只能靠第二层」的对照由**同一份实发素材**上的两次测量给出
// （带 / 不带 `preserveToolNames`），不靠多烧一次探针调用。

// ── 跨压缩迭代（轮 3/轮 4，T4.08）：第二次压缩看到的是第一次压缩后的历史 ──
//
// 本段证的是 B-3「不会进入永久无法压缩状态」：第一次分片压缩之后会话**仍然可压**，且迭代链不断。
// `prepareCompaction` 在存在前序 compaction 条目时把 compactableEntries 拼成「前序 `retainedTail`
// 的虚拟条目 + 该条目之后的真实条目」（`compaction.js` 的 426-437 行），`previousSummary` 取前一条
// compaction 条目的 `summary`（424-428 行）。于是第二次压缩的四条事实就是本段的断言对象：
//
//   ① 素材 = 第一次的保留段（轮 2 的**收尾回复**，一条短句，走虚拟保留条目）+ 轮 3 的两条探针
//      + 轮 4 的前缀单元（正文 + toolCall + 承载结果）；
//   ② 第 1 片的 `previousSummary` 是**第一条 compaction 条目的摘要**（不再是 null）——
//      「跨压缩的迭代链」没有断；
//   ③ `contextEpoch` 两次推进（每次提交 +1，`harness-slot.ts` 的 compaction_end）；
//   ④ 两次压缩之后**原文条目仍逐字不变**（压缩只改请求视图，4 条探针结果全在）。
//
// ── 轮 3/轮 4 的载荷（与轮 1/轮 2 同构）──
//
// 轮 3 再连续调用 preserve 探针两次（同样的两条长结果），轮 4 再取一份承载结果（同样越过保留
// 窗口，切点落在轮 4 的收尾回复上）。与轮 1/轮 2 的差别只有一处**必须**小心的量：第二次压缩的
// 视图里同时挂着**两段**内容（保留段里的短回复 + 轮 4 的承载结果），而阈值压缩先于硬预算触发
// —— 视图越过 `normalInputTarget` 就会在轮 4 回合内先压一次，第二次手动压缩面对的是已被压过的
// 会话。探针与承载结果的尺寸按同一组前提推导（见 `PROBE_CHARS` / `HOLD_TOKENS`），
// `assertSecondPayloadPremise` 在 setup 里把这组前提再钉一遍（含「视图不越阈值」）。

const PRESERVE_TOOL_ID = "shard-preserve-probe"
const PRESERVE_TOOL_NAME = "shard_preserve_probe"
const REFERENCE_TOOL_ID = "shard-reference-probe"
const REFERENCE_TOOL_NAME = "shard_reference_probe"
/** 轮 3 的第二批探针：与轮 1 同声明、同结果长度，只有名字不同（两次压缩的探针在断言里各数各的）。 */
const SECOND_PRESERVE_TOOL_ID = "shard-second-preserve-probe"
const SECOND_PRESERVE_TOOL_NAME = "shard_second_preserve_probe"
/** 承载切点的工具：轮 2 / 轮 4 各调用一次，结果与探针同量级地长（preserve ⇒ 尺寸确定）。 */
const HOLD_TOOL_ID = "shard-cut-hold"
const HOLD_TOOL_NAME = "shard_cut_hold"
/** 本场景声明的全部 preserve 工具名：素材度量（`measured`）与投影前提共用这一份名单。 */
const PRESERVE_TOOL_NAMES: ReadonlySet<string> = new Set([PRESERVE_TOOL_NAME, SECOND_PRESERVE_TOOL_NAME, HOLD_TOOL_NAME])

const FAKE_MODEL: FauxModelDefinition = { id: "deskpet-fake", name: "Desk-Pet Fake", contextWindow: 131_072, maxTokens: 16_384 }
/** 真正生效的窗口与 `resolvePiTurnModel` 一致：配置值与注入模型窗口取小（maxTokens 由预算覆盖）。 */
const WINDOW_TOKENS = Math.min(aiConfig.contextMaxTokens, 131_072)
const BUDGET = contextBudget(WINDOW_TOKENS)
/** 压缩设置与 `harness-slot.ts` 同一条表达式（maxOutput 取同一个预算的 outputReserve）：保留窗口从这里来。 */
const SETTINGS = compactionSettingsFor(WINDOW_TOKENS, BUDGET.outputReserve)
/** 单片素材预算：与 `summarizeCompaction` 传给规划器的实参同一条表达式，不另写一份口径。 */
const SLICE_BUDGET = Math.floor(BUDGET.hardInputLimit * COMPACTION_SLICE_RATIO)

/** 切点承载结果的余量：「≥ 保留窗口」留 5%，防估算取整与配置漂移。 */
const HOLD_MARGIN = 1.05
/**
 * 承载切点的**工具结果**（轮 2 / 轮 4 各一条，preserve ⇒ 不缩短、不清空）。两个硬约束逼它这么铺：
 *
 * ① **切点必须落在一条「最后的消息」能被它顶过 `keepRecentTokens` 的位置**：上游从末尾累加，
 *    撞上它（80,000+ 字符 = 20,000+ tokens，见下）就断在它身上，切点随即落在其后的助手消息上 ——
 *    而那条助手消息**前面正是这条结果**（是消息）⇒ 切点不再被审计快照的回退循环推走（文件头的
 *    「切点由哪条消息承载」），该回合的前半段（user + toolCall + 这条结果）成前缀单元、两段探针
 *    整体留在 `messagesToSummarize` 里。
 * ② **它不能用助手回复承载**：助手消息走 faux 的流式，每 ~16 字符一帧、实测每帧 ≈248 字节
 *    （帧行 JSON 开销）⇒ 8.4 万字符的回复 ≈ 1.3 MB 只帧开销；工具结果不产生帧，同样的 token 量
 *    只要 ≈ 80 KB（ASCII 1 字节/字符）。W6 第二次实跑正是被这条击穿：会话必须 < 5 MiB
 *    （Rust `file_read` 的整文件门，超了连会话头都读不出），见文件头的「会话文件字节账」。
 */
const HOLD_CHARS = Math.ceil(SETTINGS.keepRecentTokens * 4 * HOLD_MARGIN)
const HOLD_TOKENS = Math.ceil(HOLD_CHARS / 4)
const HOLD_RESULT = "a".repeat(HOLD_CHARS)

/** 视图余量：系统前缀、工具 schema 与逐条结构开销的定量预留（轮 2 实测只被吃掉 ≈1,100）。 */
const VIEW_SLACK = 4_000

/**
 * 单条探针的字符数（ASCII 引号 ⇒ 素材成本 = 字符数 ÷ 2，视图成本 = 字符数 ÷ 4）。
 *
 * 三条前提把取值夹成一个区间，取靠下界的 1/8 处（不取中点，理由在第三条）：
 * - **素材侧下界**：两条探针的素材（各 探针字符数 / 2）+ 承载结果必须**超过硬上限**
 *   ⇒ 探针字符数 > hardInputLimit − HOLD_TOKENS；
 * - **视图侧上界**：两条探针的视图（各 探针字符数 / 4）+ 承载结果 + 余量必须留在**阈值**
 *   （normalInputTarget）以内 —— 阈值压缩先于硬预算触发，一旦在回合内压过，/compact 面对的是
 *   已被压过的会话（分片前提被破坏）⇒ 探针字符数 ≤ 2 × (normalInputTarget − HOLD_TOKENS − VIEW_SLACK)；
 * - **会话文件预算**：每条探针的字符在盘上会出现 6 遍（暂存 payload、提交条目、它所属那次压缩的
 *   `pi.op.preparation`，各 2 字节/字符 —— 引号转义成 `\"`）⇒ 四条合计 ≈ 24 × 探针字符数字节、
 *   是文件里最大的一块（见文件头的「会话文件字节账」）；素材侧是确定性估算（纯 ASCII 引号，
 *   无漂移），所以取值从下界只往上取 1/8，不取中点。
 */
const PROBE_LOWER_CHARS = BUDGET.hardInputLimit - HOLD_TOKENS
const PROBE_UPPER_CHARS = (BUDGET.normalInputTarget - HOLD_TOKENS - VIEW_SLACK) * 2
const PROBE_CHARS = PROBE_LOWER_CHARS + Math.floor((PROBE_UPPER_CHARS - PROBE_LOWER_CHARS) / 8)
/** 单条探针的视图成本（ASCII 4 字符 ≈ 1 token）：断言里按它给载荷下限。 */
const PROBE_VIEW_TOKENS = Math.floor(PROBE_CHARS / 4)
const PROBE_RESULT = "\"".repeat(PROBE_CHARS)

const FIRST_TEXT = `第一轮：连续调用 ${PRESERVE_TOOL_NAME} 两次，然后回复我。`
/** 轮 2 / 轮 4 的正文只负责起回合：切点承载量全在工具结果上（它自己越长越费盘，没有别的作用）。 */
const SECOND_TEXT = "第二轮：再取一份保留样本，然后回复我。"
const THIRD_TEXT = `第三轮：再连续调用 ${SECOND_PRESERVE_TOOL_NAME} 两次，然后回复我。`
const FOURTH_TEXT = "第四轮：再取一份保留样本，然后回复我。"

/** 断言失败时带上真实口径，不让人从「未覆盖」反推载荷问题。 */
function sizing(): string {
  return `窗口 ${WINDOW_TOKENS}、hardInputLimit ${BUDGET.hardInputLimit}、阈值 ${BUDGET.normalInputTarget}`
    + `、sliceBudget ${SLICE_BUDGET}、单条探针 ${PROBE_CHARS} 字符（视图 ${PROBE_VIEW_TOKENS} tokens，两次压缩共用）`
    + `、保留窗口 ${SETTINGS.keepRecentTokens}、切点承载结果 ${HOLD_CHARS} 字符（${HOLD_TOKENS} tokens）×2`
}

/**
 * 载荷前提（setup 里显式失败）：素材必须真的超硬上限、视图（含系统前缀余量）必须留在阈值以内、
 * 轮 2 的**切点承载结果**必须自己越过保留窗口、单个工具批次装得进单片预算而两批合起来装不进
 * （前者防一个批次独占整片 / 再大就是 oversized_unit fatal，后者保 K ≥ 2）。
 * 五条都由上面同一批预算常量推导 —— 窗口或估算器口径漂移时先在这里给出可读原因，
 * 不让断言在错误载荷上空转（同 `压缩降级` 的 `assertPayloadPremise`）。
 * 切点的真实形态另有基于**上游真件**的复核（`preparation()` + `assertPreparationShape`）。
 */
function assertPayloadPremise(): void {
  // 素材成本（token）：两条探针各 PROBE_CHARS / 2（JSON 转义把字符数翻倍、再按 4 字符/token）
  // + 切点承载结果 HOLD_TOKENS（纯 ASCII，不放大）+ 逐条结构开销（离线实测 ≈750，这里滚进余量）。
  const material = PROBE_CHARS + HOLD_TOKENS
  if (!(material > BUDGET.hardInputLimit)) {
    throw new Error(`场景载荷前提不成立：两条探针 + 承载结果的素材 ${material} 不超过硬上限 ${BUDGET.hardInputLimit}｜${sizing()}`)
  }
  const view = 2 * PROBE_VIEW_TOKENS + HOLD_TOKENS + VIEW_SLACK
  if (!(view < BUDGET.normalInputTarget)) {
    throw new Error(`场景载荷前提不成立：请求视图 ${view}（含系统前缀余量 ${VIEW_SLACK}）越过压缩阈值 ${BUDGET.normalInputTarget}：`
      + `回合内会先发生阈值压缩，手动 /compact 面对的是已被压过的素材｜${sizing()}`)
  }
  if (!(HOLD_TOKENS >= SETTINGS.keepRecentTokens)) {
    throw new Error(`场景载荷前提不成立：切点承载结果 ${HOLD_TOKENS} tokens 没有越过保留窗口 ${SETTINGS.keepRecentTokens}：`
      + `切点不会被它顶过阈值，反而会落进探针所在回合（两段探针进永不切分的前缀单元 ⇒ 规划 fatal）｜${sizing()}`)
  }
  // 单片装得下：一个工具批次的**素材**（token）必须留在单片预算内 —— 超预算它就只能独占一片，
  // 再超过硬上限就是 oversized_unit fatal。左侧是 token，不是字符（引号结果 1 字符 = 1/2 素材 token）。
  const batch = PROBE_CHARS / 2
  if (!(batch <= SLICE_BUDGET)) {
    throw new Error(`场景载荷前提不成立：单个工具批次的素材 ${batch} 装不进单片预算 ${SLICE_BUDGET}（不可分片）｜${sizing()}`)
  }
  // 合起来装不下：两个批次（各 batch）的素材合计超过单片预算 ⇒ 贪心装箱必分两片（K ≥ 2 构造性成立）。
  if (!(2 * batch > SLICE_BUDGET)) {
    throw new Error(`场景载荷前提不成立：两个工具批次的素材合计 ${2 * batch} 装得进单片预算 ${SLICE_BUDGET}（K 会退化成 1）｜${sizing()}`)
  }
}

/**
 * 第二次压缩（跨压缩迭代）的载荷前提（与 `assertPayloadPremise` 同构、同一批常量推导）：
 * ① 两条新探针 + 轮 4 的承载结果仍要超硬上限（否则第二次压缩不走分片）；
 * ② 轮 4 的请求视图（两条新探针 + 轮 4 的承载结果 + 余量）必须留在阈值以内（否则轮 4
 *    回合内先发生阈值压缩，第二次手动压缩面对的是已被压过的会话）；
 * ③ 轮 4 的承载结果同样越过保留窗口（切点承载者，理由同轮 2）；
 * ④ 每个工具批次仍装得进单片预算、且两批仍必分家（K₂ ≥ 2）。
 */
function assertSecondPayloadPremise(): void {
  // 素材成本（token）= 两条新探针（各 PROBE_CHARS / 2）+ 轮 4 的承载结果（保留段是短回复，不计量）。
  const material = PROBE_CHARS + HOLD_TOKENS
  if (!(material > BUDGET.hardInputLimit)) {
    throw new Error(`第二次压缩的载荷前提不成立：两条新探针 + 轮 4 承载结果的素材 ${material} 不超过硬上限 ${BUDGET.hardInputLimit}｜${sizing()}`)
  }
  const view = 2 * PROBE_VIEW_TOKENS + HOLD_TOKENS + VIEW_SLACK
  if (!(view <= BUDGET.normalInputTarget)) {
    throw new Error(`第二次压缩的载荷前提不成立：轮 4 请求视图 ${view}（含前缀余量 ${VIEW_SLACK}）越过压缩阈值 `
      + `${BUDGET.normalInputTarget}：回合内会先发生阈值压缩，第二次手动压缩面对的是已被压过的会话｜${sizing()}`)
  }
  if (!(HOLD_TOKENS >= SETTINGS.keepRecentTokens)) {
    throw new Error(`第二次压缩的载荷前提不成立：轮 4 承载结果 ${HOLD_TOKENS} tokens 没有越过保留窗口 ${SETTINGS.keepRecentTokens}：`
      + `切点会落进轮 3（两条新探针进永不切分的前缀单元 ⇒ 规划 fatal）｜${sizing()}`)
  }
  const batch = PROBE_CHARS / 2
  if (!(batch <= SLICE_BUDGET)) {
    throw new Error(`第二次压缩的载荷前提不成立：单个工具批次的素材 ${batch} 装不进单片预算 ${SLICE_BUDGET}（不可分片）｜${sizing()}`)
  }
  if (!(2 * batch > SLICE_BUDGET)) {
    throw new Error(`第二次压缩的载荷前提不成立：两个工具批次的素材合计 ${2 * batch} 装得进单片预算 ${SLICE_BUDGET}（K₂ 会退化成 1）｜${sizing()}`)
  }
}

/** 声明指定 `resultProjection` 的只读工具（探针与切点承载结果共用）：唯一变量就是投影声明。 */
const probe = (id: string, name: string, projection: "preserve" | "reference", result: string): ToolDef =>
  defineTool({
    id, name,
    description: `分片载荷工具 ${name}：声明 resultProjection=${projection} 的长结果工具`,
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

/** 一次请求的最后一条消息正文：摘要请求与主请求都从这里分辨（摘要素材的 JSON 才有 `"instructions"`）。 */
/** 摘要请求脚本：被非摘要请求取走就是脚本错位，立即报错（同 `压缩降级` 的做派）。 */
const summaryStep: FauxResponseFactory = context => {
  const text = lastRequestText(context)
  if (!text.includes("\"instructions\"")) throw new Error(`摘要脚本被非摘要请求取走: ${text.slice(0, 60)}`)
  summaryRequests.push(text)
  return fakeText(summaryResponse(summaryRequests.length))
}

/** 轮 3/轮 4 的会话步骤队列（setup 每次重建）：路由步按需取走，摘要请求不消耗它。 */
let trailingQueue: FauxResponseStep[] = []

/** 轮 3 的两次探针调用与收尾回复、轮 4 的回复 —— 队列顺序即请求顺序。 */
function trailingScript(): FauxResponseStep[] {
  return [
    recorded("轮 3 / 第 1 次探针调用", fakeToolCall(SECOND_PRESERVE_TOOL_NAME, {}, "shard-second-call-1")),
    recorded("轮 3 / 第 2 次探针调用", fakeToolCall(SECOND_PRESERVE_TOOL_NAME, {}, "shard-second-call-2")),
    recorded("轮 3 / 收尾回复", fakeText("第三轮回复完成。")),
    // 轮 4 的承载结果调用 + 收尾回复：切点落在轮 4 的回复上（见 `HOLD_RESULT` 与文件头）。
    recorded("轮 4 / 承载结果调用", fakeToolCall(HOLD_TOOL_NAME, {}, "shard-hold-call-2")),
    recorded("轮 4 / 本轮回复", fakeText("第四轮回复完成。")),
  ]
}

/**
 * 尾部路由步：这一次请求是摘要还是会话，由请求正文自己说 —— 摘要片数（K₁/K₂）由载荷决定、
 * 不在场景里写死，「第 N 步必是摘要」的固定脚本在片数漂移时会把会话步骤喂给摘要请求。
 * 摘要请求就地应答（与 `summaryStep` 同一份账、同一份正文），会话请求按顺序取走 `trailingQueue`；
 * 队列空了还来会话请求才是脚本错位。多备的步骤不会被取走（每个请求只弹一步）。
 */
const routedStep: FauxResponseStep = (context, options, state, model) => {
  if (lastRequestText(context).includes("\"instructions\"")) return summaryStep(context, options, state, model)
  const next = trailingQueue.shift()
  if (!next) {
    throw new Error(`尾部会话脚本已耗尽（第 ${state.callCount} 次请求）：既不是摘要请求，队列里也没有剩余的会话步骤`)
  }
  return typeof next === "function" ? next(context, options, state, model) : next
}

// ── 会话条目 → 素材：唯一重建点 = 上游 `prepareCompaction` 真件 ──

/** 存档侧的工具结果条目：正文、工具名与条目 id 一起取。 */
function toolResults(entries: Entry[]): { id: string; toolName: string; text: string }[] {
  return entries.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult"
    ? [{ id: entry.id, toolName: entry.message.toolName ?? "", text: contentText(entry.message.content) }]
    : [])
}

/**
 * 摘要素材的唯一重建点：直接调上游 `prepareCompaction`（与 Harness 同一个函数、同一份 `SETTINGS`），
 * 场景不再自己推导切点。
 *
 * 旧版按「切点落在最后一个用户消息上」手算 `messages.slice(0, lastUserIndex)` —— 那个模型在带
 * 审计快照的链表上不成立（快照条目把切点推回「上一条消息之后」，见文件头的「切点由哪条消息承载」）：
 * 实跑里轮 1 整轮成了 `turnPrefixMessages`，场景却按「无前缀」重建，断言与真实素材分家。
 * 真件把 `messagesToSummarize` / `turnPrefixMessages` / `retainedTail` / `previousSummary` 一次
 * 算全；第二次压缩的「前序 retainedTail 虚拟条目 + 该条目之后的真实条目」也由上游在同一处拼装
 * （`compaction.js` 的 424-437 行），不需要第二份重建。传入的条目与 Harness 读的是同一份
 * （`sessions/` JSONL 的 asc 序）。
 */
async function preparation(): Promise<CompactionPreparation> {
  const prepared = prepareCompaction(await sessionEntries(), SETTINGS)
  if (!prepared.ok) throw new Error(`上游 prepareCompaction 报错：${formatError(prepared.error)}｜${sizing()}`)
  if (prepared.value === undefined) {
    throw new Error(`上游判定无可压缩材料（会话尾是 compaction、或切点之前没有可摘要范围）：素材无从重建｜${sizing()}`)
  }
  return prepared.value
}

/**
 * 切点前提（用上游真件核对，不靠场景的常量推导）：两段**探针结果**必须整体落在
 * `messagesToSummarize` 里 —— 前缀单元永不切分，探针落进去就是 `fatal{oversized_unit}`
 * （一个工具批次的素材 PROBE_CHARS / 2，两批合起来 PROBE_CHARS > 硬上限）。前缀里允许有
 * 别的东西（本轮正是那条切点承载结果 + 起回合的 user/assistant），只禁止探针。
 * 前提不成立时给出可读原因，不让后面的断言在错误素材上空转。
 */
function assertPreparationShape(input: CompactionPreparation, label: string): void {
  const isProbe = (message: AgentMessage): boolean =>
    message.role === "toolResult"
    && (message.toolName === PRESERVE_TOOL_NAME || message.toolName === SECOND_PRESERVE_TOOL_NAME)
  const results = input.messagesToSummarize.filter(isProbe)
  if (results.length !== 2) {
    throw new Error(`${label}的 messagesToSummarize 里应恰好 2 条探针结果，实际 ${results.length} 条：`
      + `切点落进了探针所在回合 ⇒ 探针进永不切分的前缀单元 ⇒ 规划直接 fatal oversized_unit｜${sizing()}`)
  }
  if (input.turnPrefixMessages.some(isProbe)) {
    throw new Error(`${label}的 turnPrefixMessages 里出现了探针结果：探针批次落进永不切分的前缀单元｜${sizing()}`)
  }
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

/** 片请求正文的解析形态：断言与覆盖对照共用（`previousSummary` + 两段素材分区）。 */
type SummaryBody = { previousSummary?: unknown; messages?: unknown[]; splitTurnPrefix?: unknown[] }

function projectedMessages(body: SummaryBody): ProjectedMessage[] {
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

/**
 * 素材的一条测量记录：供断言与错误消息复用（多次测量共用同一批消息、前缀与地址）。
 * 形状与 `summarizeCompaction` 的调用同源：`messages` 与 `turnPrefixMessages` 就是
 * `preparation` 给的两个分区，素材的完整数组 = 两者按序拼接（`sliceMaterial` 的语义）。
 */
function measured(
  messages: readonly AgentMessage[],
  preserve: ReadonlySet<string>,
  refs?: ReadonlyMap<string, string>,
  turnPrefixMessages?: readonly AgentMessage[],
): CompactionMaterial {
  return measureCompactionMaterial({
    messages,
    ...(turnPrefixMessages?.length ? { turnPrefixMessages } : {}),
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
    // 显式给足预算：一次 trial 要走 4 个回合 + 两次 K ≥ 2 的分片压缩（每片一次一次性请求），
    // 载荷里还有两条 8.4 万字符的回复要按帧流式落地与两次 16 万 token 级的素材投影 ——
    // 默认 120 s 是 W6 首跑的显式观察项（先例：`阶梯投影` / `折叠完整性` 的 180_000）。
    timeout: 180_000,
    tags: ["memory", "compaction", "boundary"],
  },
  setup: async () => {
    assertPayloadPremise()
    assertSecondPayloadPremise()
    summaryRequests.length = 0
    viewSamples.length = 0
    trailingQueue = trailingScript()
    unregister(PRESERVE_TOOL_ID)
    unregister(REFERENCE_TOOL_ID)
    unregister(SECOND_PRESERVE_TOOL_ID)
    unregister(HOLD_TOOL_ID)
    register(probe(PRESERVE_TOOL_ID, PRESERVE_TOOL_NAME, "preserve", PROBE_RESULT))
    register(probe(REFERENCE_TOOL_ID, REFERENCE_TOOL_NAME, "reference", PROBE_RESULT))
    register(probe(SECOND_PRESERVE_TOOL_ID, SECOND_PRESERVE_TOOL_NAME, "preserve", PROBE_RESULT))
    register(probe(HOLD_TOOL_ID, HOLD_TOOL_NAME, "preserve", HOLD_RESULT))
    installFakeProvider([
      recorded("轮 1 / 第 1 次探针调用", fakeToolCall(PRESERVE_TOOL_NAME, {}, "shard-preserve-call-1")),
      recorded("轮 1 / 第 2 次探针调用", fakeToolCall(PRESERVE_TOOL_NAME, {}, "shard-preserve-call-2")),
      recorded("轮 1 / 收尾回复", fakeText("第一轮回复完成。")),
      // 轮 2 的承载结果调用 + 收尾回复：切点落在轮 2 的回复上（见 `HOLD_RESULT` 与文件头）。
      recorded("轮 2 / 承载结果调用", fakeToolCall(HOLD_TOOL_NAME, {}, "shard-hold-call-1")),
      recorded("轮 2 / 本轮回复", fakeText("第二轮回复完成。")),
      // 之后全是路由步：摘要请求就地应答、会话请求取走 `trailingQueue`（轮 3 四次 + 轮 4 两次）。
      // 备足「两次压缩各自的片数上限 + 尾部会话步骤」——每个请求只弹一步，多出来的不会被取走。
      ...Array.from({ length: 2 * MAX_COMPACTION_SLICES + trailingQueue.length }, () => routedStep),
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
          // 载荷声明自证：承载结果的投影必须是 preserve —— 素材尺寸靠它确定（被 L0 缩短就少了
          // HOLD_TOKENS − 单条上限 ≈10.5k，素材会跌回硬上限以内，分片路径根本不会发生）。
          const holdProjection = getToolByName(HOLD_TOOL_NAME)?.policy.context.resultProjection
          if (holdProjection !== "preserve") {
            throw new Error(`切点承载结果的投影声明漂了：${HOLD_TOOL_NAME}=${String(holdProjection)}｜${sizing()}`)
          }
          // 轮 2 的请求视图（带着两条探针结果与切点承载结果）：它必须装得进硬上限，且真的带着载荷。
          // 阈值（`normalInputTarget`）那边不在这里断言：那是 Harness 自己的读数（有 usage 时按
          // provider 的真实用量计），本仓估算在中文字符上更保守，拿它硬比会误红。载荷侧把
          // 「2 × 探针视图 + 承载结果」压在阈值以下留出的余量，就是上面第一条断言成立的前提。
          if (viewSamples.length !== 5) {
            throw new Error(`到轮 2 断言为止的请求采样应为 5 次（轮 1 三次 + 轮 2 两次：承载结果调用与收尾回复），`
              + `实际 ${viewSamples.length} 次（脚本与真实循环不同步）｜${sizing()}`)
          }
          const latest = viewSamples[viewSamples.length - 1]!
          if (latest.used > BUDGET.hardInputLimit) {
            throw new Error(`轮 2 的请求视图「${latest.label}」${latest.used} tokens 超过硬上限 ${BUDGET.hardInputLimit}｜${sizing()}`)
          }
          if (!(latest.used >= 2 * PROBE_VIEW_TOKENS + HOLD_TOKENS)) {
            throw new Error(`轮 2 的请求视图「${latest.label}」只有 ${latest.used} tokens，`
              + `小于「两条探针 + 切点承载结果」的视图成本 ${2 * PROBE_VIEW_TOKENS + HOLD_TOKENS}：载荷没有完整进请求｜${sizing()}`)
          }
        } },
        { type: "expectPreserveGatesFirstLayer", run: async () => {
          // 素材用上游真件重建（`prepareCompaction`）；切点形态由它给，不再由场景推导。
          const prep = await preparation()
          const messages = prep.messagesToSummarize
          const prefix = prep.turnPrefixMessages
          // 切点前提：两段探针必须整体落在 messagesToSummarize 里（前缀单元永不切分，
          // 探针落进去就是 fatal oversized_unit —— 单独报出来，别让下面的读数掩盖真正的原因）。
          assertPreparationShape(prep, "第一次压缩")
          const preserve = toolResults(await sessionEntries()).filter(result => result.toolName === PRESERVE_TOOL_NAME)
          if (preserve.length !== 2) {
            throw new Error(`存档里的 preserve 结果应为 2 条，实际 ${preserve.length} 条（载荷在场景准备阶段就变了）｜${sizing()}`)
          }
          // ① 带 preserve 声明：两条结果禁止二次处理 ⇒ 素材 ≈ 2 × 80k > 硬上限，第一层（级 1/2）无效。
          const withPreserve = measured(messages, PRESERVE_TOOL_NAMES, undefined, prefix)
          if (!(withPreserve.used > BUDGET.hardInputLimit)) {
            throw new Error(`preserve 载荷的素材只有 ${withPreserve.used} tokens，未超硬上限 ${BUDGET.hardInputLimit}`
              + `（探针结果 ${preserve.map(result => result.text.length).join("/")} 字符）｜${sizing()}`)
          }
          // ② 去掉 preserve 声明（对照）：同一条结果被 L0 缩短，素材落回硬上限以内 —— 第一层就能消化，
          //    第二层根本不会被触发。这一对断言就是「preserve 让第一层无效、只能靠第二层」的用例。
          const withoutPreserve = measured(messages, new Set<string>(), undefined, prefix)
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
          // 压缩前的素材（上游真件）：切点形态先复核，覆盖对照的基线也与它同源。
          const prep = await preparation()
          assertPreparationShape(prep, "第一次压缩")
          // B-1 主断言：超硬上限的素材**不 decline**，分片产出摘要并一次性提交。
          const outcome = await compactActiveSession(sessionId)
          if (outcome.status !== "completed") {
            throw new Error(`手动压缩没有完成：status=${outcome.status}`
              + `${outcome.error ? ` (${outcome.error})` : ""}｜${sizing()}`)
          }
          const bodies = summaryRequests.map(text => JSON.parse(text) as SummaryBody)
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
          // prefix 片的内容，这条是把两边都拼起来比；基线就是上游真件给的完整素材（含前缀分区）。
          const slices = bodies.map(body => projectedMessages(body))
          const refs = issuedAddressRefs(slices, toolResults(before).map(result => result.id))
          if (refs.size === 0) {
            throw new Error("片请求正文里没有回读地址：基线无法与实发形态同源，覆盖对照会因地址尾行不同而假失败")
          }
          const baseline = measured(prep.messagesToSummarize, PRESERVE_TOOL_NAMES, refs, prep.turnPrefixMessages)
          const full = projectedMessages(JSON.parse(baseline.userText) as SummaryBody)
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
          // 第一批探针只属于本场景：观测完成后移出注册表（同 `摘要投影口径`）。
          unregister(PRESERVE_TOOL_ID)
          unregister(REFERENCE_TOOL_ID)
        } },
      ],
    },
    {
      index: 3,
      description: "第二批 preserve 探针再连续执行两次：结果全文落盘，三次请求视图仍装得进硬上限",
      userText: THIRD_TEXT,
      checks: [{ type: "expectSecondProbeResultsStored", run: async context => {
        if (context.output.failure) throw new Error(`第三轮失败：${context.output.failure.message}`)
        // 载荷声明先自证（与轮 1 同款）：第二批探针的投影声明也在册。
        const declared = getToolByName(SECOND_PRESERVE_TOOL_NAME)?.policy.context.resultProjection
        if (declared !== "preserve") {
          throw new Error(`第二批探针的投影声明漂了：${SECOND_PRESERVE_TOOL_NAME}=${String(declared)}`)
        }
        // 探针真实执行：存档里恰好两条第二批结果，且都是**全文**（缩短只发生在投影上）。
        // 对照探针不参与载荷：它一旦被调用就说明脚本错位。
        const results = toolResults(await sessionEntries())
        const second = results.filter(result => result.toolName === SECOND_PRESERVE_TOOL_NAME)
        const reference = results.filter(result => result.toolName === REFERENCE_TOOL_NAME)
        if (reference.length !== 0) {
          throw new Error(`对照探针被调用（${reference.length} 条结果）：载荷被改动，素材与视图的数字不再同源｜${sizing()}`)
        }
        if (second.length !== 2) {
          throw new Error(`${SECOND_PRESERVE_TOOL_NAME} 的结果应为 2 条（同轮连续两次），实际 ${second.length} 条`
            + `（现有工具结果：${JSON.stringify(results.map(result => result.toolName))}）｜${sizing()}`)
        }
        for (const result of second) {
          if (result.text.length < PROBE_CHARS) {
            throw new Error(`第二批探针 ${result.id} 的存档结果不是全文（长度 ${result.text.length}，应 ≥ ${PROBE_CHARS}）：`
              + `缩短只能发生在投影上`)
          }
        }
        // 视图前提：轮 3 的三次请求都由真链路发出且都未被硬预算闸门拦下（被拦下就不会有工具执行）。
        // 末次请求（收尾回复）同时带着两条新结果：它就是「新结果以全文进视图」的证据。
        if (viewSamples.length !== 8) {
          throw new Error(`到轮 3 断言为止的请求采样应为 8 次（轮 1 三次 + 轮 2 两次 + 轮 3 三次），`
            + `实际 ${viewSamples.length} 次（脚本与真实循环不同步）｜${sizing()}`)
        }
        for (const sample of viewSamples.slice(viewSamples.length - 3)) {
          if (sample.used > BUDGET.hardInputLimit) {
            throw new Error(`请求视图「${sample.label}」${sample.used} tokens 超过硬上限 ${BUDGET.hardInputLimit}：`
              + `视图会被闸门拦下（要么改走溢出恢复、要么探针根本不会执行）｜${sizing()}`)
          }
        }
        const withBoth = viewSamples[viewSamples.length - 1]!
        if (!(withBoth.used >= 2 * PROBE_VIEW_TOKENS)) {
          throw new Error(`两条新探针结果都进了上下文的请求视图只有 ${withBoth.used} tokens，`
            + `小于两条新探针的视图成本 ${2 * PROBE_VIEW_TOKENS}：preserve 结果没有以全文进视图（载荷机制不成立）｜${sizing()}`)
        }
      } }],
    },
    {
      index: 4,
      description: "第二次手动分片压缩（跨压缩迭代）：第 1 片带上前一条 compaction 的摘要，contextEpoch 推进到 2，原文逐字不变",
      userText: FOURTH_TEXT,
      checks: [
        { type: "expectNoCompactionBeforeSecondManual", run: async context => {
          if (context.output.failure) throw new Error(`第四轮失败：${context.output.failure.message}`)
          // 第二次手动压缩必须面对**跨压缩迭代的那份素材**：只允许存在第一次提交的 1 条 compaction 条目。
          // 轮 3/轮 4 的视图若被阈值命中，回合内会先压一次，随后 /compact 面对的是已被压过的会话
          // （素材缩水、previousSummary 链换成阈值压缩的产出）。如实失败，不让 B-3 断言以别的原因红。
          const compactions = compactionEntries(await sessionEntries())
          if (compactions.length !== 1) {
            throw new Error(`第二次手动压缩前应恰好 1 条 compaction 条目（第一次分片的产出），实际 ${compactions.length} 条：`
              + `轮 3/轮 4 里又发生了压缩，跨压缩迭代的素材已被压过｜${sizing()}`)
          }
          // 轮 4 的请求视图：轮 4 的切点承载结果与两条新探针结果都要在里面（保留段只有一条短回复）。
          if (viewSamples.length !== 10) {
            throw new Error(`到轮 4 断言为止的请求采样应为 10 次（轮 1 三次 + 轮 2 两次 + 轮 3 三次 + 轮 4 两次），`
              + `实际 ${viewSamples.length} 次（脚本与真实循环不同步）｜${sizing()}`)
          }
          const latest = viewSamples[viewSamples.length - 1]!
          if (latest.used > BUDGET.hardInputLimit) {
            throw new Error(`轮 4 的请求视图「${latest.label}」${latest.used} tokens 超过硬上限 ${BUDGET.hardInputLimit}｜${sizing()}`)
          }
          if (!(latest.used >= 2 * PROBE_VIEW_TOKENS + HOLD_TOKENS)) {
            throw new Error(`轮 4 的请求视图「${latest.label}」只有 ${latest.used} tokens，小于「两条新探针 + 轮 4 承载结果」`
              + `的视图成本 ${2 * PROBE_VIEW_TOKENS + HOLD_TOKENS}：跨压缩的载荷没有完整进请求｜${sizing()}`)
          }
          // 阈值前提：手动压缩能面对未压过素材，靠的是回合内**没有**先被阈值命中。本仓估算对非 ASCII
          // 按 1 token/字符计、比上游的 chars/4 保守，这条只会比 Harness 的判定更严，不会假绿。
          if (latest.used > BUDGET.normalInputTarget) {
            throw new Error(`轮 4 的请求视图「${latest.label}」${latest.used} tokens 越过压缩阈值 ${BUDGET.normalInputTarget}：`
              + `回合内会先发生阈值压缩，第二次手动压缩面对的是已被压过的会话（载荷或宿主前缀变大了）｜${sizing()}`)
          }
        } },
        { type: "expectSecondShardCompactionCompletes", run: async () => {
          const sessionId = getActiveSessionId()
          const before = await sessionEntries(sessionId)
          const first = compactionEntries(before)
          if (first.length !== 1) {
            throw new Error(`跨压缩链的前序应恰好 1 条 compaction 条目，实际 ${first.length} 条｜${sizing()}`)
          }
          const previous = first[0]!
          // 第二次压缩的素材同样用上游真件重建（它在同一处拼「前序 retainedTail 虚拟条目 + 其后条目」）。
          const prep = await preparation()
          assertPreparationShape(prep, "第二次压缩")
          if (prep.previousSummary !== previous.summary) {
            throw new Error(`重建口径漂了：上游给的 previousSummary 不是前一条 compaction 条目的摘要`
              + `（实际 ${JSON.stringify(prep.previousSummary)?.slice(0, 80)}）｜${sizing()}`)
          }
          const requestsBefore = summaryRequests.length
          // B-3 主断言：跨压缩迭代的那份素材**仍能分片压缩完成**（会话没有进入永久无法压缩状态）。
          const outcome = await compactActiveSession(sessionId)
          if (outcome.status !== "completed") {
            throw new Error(`第二次手动压缩没有完成：status=${outcome.status}`
              + `${outcome.error ? ` (${outcome.error})` : ""}｜${sizing()}`)
          }
          const bodies = summaryRequests.slice(requestsBefore).map(text => JSON.parse(text) as SummaryBody)
          // 片数不写死（brief 风险段）：保留段的切法会影响 K₂。上限取实现常量，下界只要求「发过请求」。
          if (bodies.length < 1) {
            throw new Error(`第二次压缩一次摘要请求都没发出（K₂ = 0）：压缩没有真的发生｜${sizing()}`)
          }
          if (bodies.length > MAX_COMPACTION_SLICES) {
            throw new Error(`第二次压缩的摘要请求 ${bodies.length} 次超过片数上限 ${MAX_COMPACTION_SLICES}｜${sizing()}`)
          }
          // 切点形态已在压缩前用上游真件核对（`assertPreparationShape`）：两段新探针在
          // messagesToSummarize 里，前缀（轮 4 的正文 + 承载结果，3 条）里没有**探针**结果 ——
          // 各片的 messages + splitTurnPrefix 拼接与真素材逐项相等，由下面的覆盖对照正面证明。
          // 覆盖对照（与轮 2 同款比法，基线换成跨压缩重建的素材）：地址从实发的片请求正文里取回，
          // 两路同源才能比出「缺失、重复、顺序变化」。
          const slices = bodies.map(body => projectedMessages(body))
          const refs = issuedAddressRefs(slices, toolResults(before).map(result => result.id))
          if (refs.size === 0) {
            throw new Error("第二次压缩的片请求正文里没有回读地址：基线无法与实发形态同源，覆盖对照会因地址尾行不同而假失败")
          }
          // 素材前提：第二次压缩的素材（前序保留段 + 两条新探针）仍超硬上限。单次路径只在素材
          // ≤ 硬上限时发生，故「completed + 素材超上限」即证明这次走的仍是分片路径。
          const materialNow = measured(prep.messagesToSummarize, PRESERVE_TOOL_NAMES, refs, prep.turnPrefixMessages)
          if (!(materialNow.used > BUDGET.hardInputLimit)) {
            throw new Error(`第二次压缩的素材只有 ${materialNow.used} tokens，未超硬上限 ${BUDGET.hardInputLimit}：`
              + `前序保留段 + 两条新探针没有凑成超限素材（跨压缩迭代的载荷前提不成立）｜${sizing()}`)
          }
          // 跨压缩迭代链：第 1 片的 previousSummary 是**第一条 compaction 条目的摘要**
          // （`prepareCompaction` 取 `prevCompaction.summary`，compaction.js 的 424-428 行），不再是 null。
          const chained = bodies[0]!.previousSummary
          if (typeof chained !== "string" || chained !== previous.summary) {
            throw new Error(`第二次压缩第 1 片的 previousSummary 不是前一条 compaction 条目的摘要（跨压缩链断了）：`
              + `实际 ${JSON.stringify(chained)?.slice(0, 120)}、应有 ${JSON.stringify(previous.summary)?.slice(0, 120)}`)
          }
          // 片内迭代：第 N 片带的是本次第 N−1 片的产出（脚本正文按全局请求序号推导，不依赖片内编号）。
          for (let index = 1; index < bodies.length; index++) {
            const summary = parseStructuredSummary(summaryResponse(requestsBefore + index))
            if (!summary) throw new Error(`场景脚本第 ${requestsBefore + index} 片的摘要不可解析（脚本自身有问题）`)
            const expected = formatStructuredSummary(summary)
            const actual = bodies[index]!.previousSummary
            if (actual !== expected) {
              throw new Error(`第二次压缩第 ${index + 1} 片的 previousSummary 不是本次第 ${index} 片的产出（迭代链断了）：`
                + `实际 ${JSON.stringify(actual)?.slice(0, 120)}、应有 ${JSON.stringify(expected).slice(0, 120)}`)
            }
          }
          // 全量覆盖：K₂ 片的 messages（prefix 走 splitTurnPrefix）按顺序拼接 === 跨压缩素材的同一投影。
          const baseline = measured(prep.messagesToSummarize, PRESERVE_TOOL_NAMES, refs, prep.turnPrefixMessages)
          const full = projectedMessages(JSON.parse(baseline.userText) as SummaryBody)
          const flattened = slices.flat()
          if (flattened.length !== full.length) {
            throw new Error(`第二次压缩的分片覆盖不全：K₂=${bodies.length} 片合计 ${flattened.length} 条素材消息，`
              + `跨压缩素材 ${full.length} 条（各片 ${JSON.stringify(slices.map(slice => slice.length))}）｜${sizing()}`)
          }
          for (let index = 0; index < full.length; index++) {
            if (contentOf(flattened[index]!) !== contentOf(full[index]!)) {
              throw new Error(`第二次压缩的覆盖在第 ${index} 条素材上不一致（缺失、重复或顺序变化）：`
                + `分片=${briefOf(flattened[index]!)}、完整素材=${briefOf(full[index]!)}｜${sizing()}`)
            }
          }
          // 提交面：两条 compaction 条目、都由钩子提交，第二条的正文是本次末片产出。
          const after = await sessionEntries(sessionId)
          const compactions = compactionEntries(after)
          if (compactions.length !== 2) {
            throw new Error(`两次分片压缩应提交 2 条 compaction 条目，实际 ${compactions.length} 条｜${sizing()}`)
          }
          if (compactions.some(entry => entry.fromHook !== true)) {
            throw new Error(`compaction 条目里有非钩子产出（fromHook=${JSON.stringify(compactions.map(entry => entry.fromHook))}）`)
          }
          const lastIntent = `第 ${summaryRequests.length} 片`
          const latestCompaction = compactions[compactions.length - 1]!
          if (!latestCompaction.summary.includes(lastIntent)) {
            throw new Error(`第二条 compaction 条目的正文不是本次末片产出（找不到「${lastIntent}」）：${latestCompaction.summary.slice(0, 120)}`)
          }
          // 换代身份：两次提交各推进一次（槽在 compaction_end 上 ++，harness-slot 的 1697 行）。
          const snapshot = harnessSlots.snapshot(sessionId)
          if (snapshot?.contextEpoch !== 2) {
            throw new Error(`contextEpoch 应为 2（两次提交各推进一次），实际 ${String(snapshot?.contextEpoch)}`
              + `${snapshot === undefined ? "（槽不在注册表：读数不可得）" : ""}｜${sizing()}`)
          }
          // 原文条目一条不少、逐字不变（按 id 对齐；这一轮的对照集合里已经包含第一条 compaction 条目本身）。
          const beforeIds = new Set(before.map(item => item.id))
          const afterById = new Map(after.map(item => [item.id, item]))
          for (const item of before) {
            const kept = afterById.get(item.id)
            if (kept === undefined) throw new Error(`第二次压缩丢掉了原文条目 ${entryBrief(item)}｜${sizing()}`)
            const [was, now] = [JSON.stringify(item), JSON.stringify(kept)]
            if (was !== now) throw new Error(`第二次压缩改写了原文条目 ${entryBrief(item)}：${divergence(was, now)}`)
          }
          // 4 条探针结果一条不少：两次压缩只改请求视图，存档正文逐字保留（压缩不许删会话真相源）。
          const probes = toolResults(after).filter(result =>
            result.toolName === PRESERVE_TOOL_NAME || result.toolName === SECOND_PRESERVE_TOOL_NAME)
          if (probes.length !== 4) {
            throw new Error(`两次压缩后存档里应有 4 条探针结果（两批各 2 条），实际 ${probes.length} 条`
              + `（现有工具结果：${JSON.stringify(toolResults(after).map(result => result.toolName))}）｜${sizing()}`)
          }
          // 新增条目只能是证据类：压缩不许把摘要或任何东西写成新的**消息**条目（同轮 2 的口径）。
          const added = after.filter(item => !beforeIds.has(item.id))
          const addedMessages = added.filter(item => item.type === "message")
          if (addedMessages.length !== 0) {
            throw new Error(`第二次压缩新增了消息条目（不应有任何一条）：${JSON.stringify(addedMessages.map(entryBrief))}`)
          }
          // 第二批探针与切点承载工具只属于本场景：观测完成后移出注册表（第一批在轮 2 末尾已注销）。
          unregister(SECOND_PRESERVE_TOOL_ID)
          unregister(HOLD_TOOL_ID)
        } },
      ],
    },
  ],
}

export default 压缩分片
