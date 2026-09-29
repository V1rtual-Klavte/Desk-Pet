import {
  DEFAULT_CONTEXT_WINDOW,
  LADDER_PROTECTION_TURNS,
  annotateToolResultText,
  contextBudget,
  estimateContextTokens,
  estimateRequestTokens,
  planToolResultLadder,
  projectToolResultText,
  protectedMessageIndexes,
  toolResultAddress,
  toolResultTokenBudget,
} from "@/services/context"
import type { ToolResultLadderEntry, ToolResultLevelMeasure } from "@/services/context"
import { createLogger } from "@/services/logger"
import type { SceneDef } from "../../../e2e/types"

// ==========================================
// O-2 阶梯保护区：轮口径、口径 B 的判定侧与 N 的校准读数（unit，不跑模型）
//
// 三条边界先写在最前，防止后来者按直觉改回：
// - 「轮」取上游 findTurnStartIndex 语义：一条 user / bashExecution 开一轮，
//   直到下一条开轮消息之前；toolResult / assistant / custom（主动消息）/
//   compactionSummary 都不开轮 —— custom 在上游是合法切分点却不是轮首，
//   主动消息因此落在「当前轮」内，不得当轮首。
// - 口径 B（2026-09-27 裁定）：保护区只挡级 2（清空）/级 3（摘要），
//   不挡级 1（缩短）—— 保护区内的超阈条目照进 levels 且值恒为 1。
// - turns <= 0 是关保护区的唯一合法方式；省略 protectedIndexes ≠ 空集
//   （省略 = 级 2 不受限，`planToolResultLadder` 会留一条 warn；本场景一律显式传入，
//   不重复触发那条警告，留痕行为由 T3.02 的探针覆盖）。
//
// 校准读数是**读数**不是通过/失败判据：只打印 target / tokensAfterLevel1 /
// tokensAfterLevel2 与保护区内/外条数，不断言最优 N —— N 的最终取值在 W6 前由用户裁定，
// 裁定后同步 `LADDER_PROTECTION_TURNS`、本场景与 docs/current/memory.md。
// ==========================================

const log = createLogger("LadderCalibration")

/** 运行期预算口径（与 runtime.ts:852-853 一致）：contextBudget(window) **不传 maxOutput**。 */
const WINDOW = DEFAULT_CONTEXT_WINDOW
const BUDGET = contextBudget(WINDOW)
const TARGET = BUDGET.normalInputTarget
const HARD_LIMIT = BUDGET.hardInputLimit
const SINGLE_RESULT_BUDGET = toolResultTokenBudget(WINDOW)

const TOOL_NAME = "read_session_event"
const SYSTEM_PROMPT = "你是 Desk-Pet 的测试用系统提示。"

/**
 * 底价正文的份额：非候选历史（静态前缀 + 工具 schema + 普通对话 + 未超阈结果）折算成
 * 一条 compactionSummary 的正文。真实的那份质量随会话变化，unit 场景取不到；
 * 这里取 target 的 80%（量级对应「已接近压缩阈值的长会话」，也正是阶梯实际介入的场景）。
 * 读数的价值在 Δ 与条数，不在这个绝对底价 —— 它只是让级 2 在 K = N..N+2 三档都可触发的合成量。
 */
const BASE_SHARE = .8
const BASE_TEXT = "底".repeat(Math.max(1, Math.floor(TARGET * BASE_SHARE)))

/** 每轮一条「超阈」结果：正文取单条 L0 预算的 4 倍（非 ASCII 按 1 token/单元，尺寸可直接读）。 */
const RAW_RESULT_MULTIPLE = 4
const RAW_RESULT_TEXT = "工".repeat(SINGLE_RESULT_BUDGET * RAW_RESULT_MULTIPLE)

/** 合成形态每轮的固定条数：user（开轮）+ assistant + toolResult（后两者不开轮）。 */
const MESSAGES_PER_TURN = 3

// ==========================================
// 第一段：轮语义的合成视图与期望集合
//
// oracle 来自**构造意图**（下面每个 role 后标的「是否开轮」），不是被测实现：
// 断言失败时给的是「哪一项被算错了」，而不是「与实现算出来的另一份数字不一致」。
// ==========================================

/** 合成视图的一项：role + 该角色按上游语义是否开一轮。 */
type RoleSpec = readonly [role: string, opensTurn: boolean]

/** 一轮的标准形态：user 开轮，assistant 与 toolResult 不开轮。 */
function turnSpec(): RoleSpec[] {
  return [["user", true], ["assistant", false], ["toolResult", false]]
}

/** 连续 `count` 轮的标准形态。 */
function turnsSpec(count: number): RoleSpec[] {
  return Array.from({ length: count }, turnSpec).flat()
}

function messagesOf(spec: readonly RoleSpec[]): Array<{ role: string }> {
  return spec.map(([role]) => ({ role }))
}

/**
 * 期望的保护集合（从构造意图推导，`turns` 默认取被测常量）：
 * 从尾部数第 `turns` 条开轮消息起全保护；不足 `turns` 条从第一条开轮消息起；
 * 一条开轮消息都没有、或 `turns <= 0` → 空集。
 */
function expectedZone(spec: readonly RoleSpec[], turns = LADDER_PROTECTION_TURNS): Set<number> {
  const zone = new Set<number>()
  if (turns <= 0) return zone
  const openers = spec.flatMap(([, opensTurn], index) => (opensTurn ? [index] : []))
  if (openers.length === 0) return zone
  const boundary = openers[Math.max(0, openers.length - turns)]
  for (let index = boundary; index < spec.length; index++) zone.add(index)
  return zone
}

/**
 * 一条断言：默认调用（读常量）与显式 turns 调用都要与构造意图一致，
 * 且迭代序升序（`protectedMessageIndexes` 承诺的稳定顺序）。
 */
function assertZone(label: string, spec: readonly RoleSpec[], turns?: number): void {
  const messages = messagesOf(spec)
  const actual = turns === undefined ? protectedMessageIndexes(messages) : protectedMessageIndexes(messages, turns)
  const expected = expectedZone(spec, turns)
  const got = [...actual].join(",")
  const want = [...expected].join(",")
  if (got !== want) throw new Error(`${label}: 保护区下标 {${got}}，期望 {${want}}（spec=${JSON.stringify(spec)}）`)
  const ascending = [...actual]
  for (let i = 1; i < ascending.length; i++) {
    if (ascending[i] <= ascending[i - 1]) throw new Error(`${label}: 保护区不是升序迭代 {${got}}`)
  }
}

// ==========================================
// 第二段：阶梯侧的合成视图（真投影函数 + 真 measure 形态）
// ==========================================

/** 合成消息：`role` 是被测函数的硬要求，其余字段按消息形态给（content / summary / toolName / details）。 */
interface ViewMessage {
  role: string
  content?: unknown
  summary?: string
  toolName?: string
  details?: unknown
}

interface LadderView {
  messages: ViewMessage[]
  entries: ToolResultLadderEntry[]
  toolIndexes: number[]
}

/** 合成视图：一条非候选历史（compactionSummary，本身也证明它不开轮）+ K 轮 ×（user, assistant, 超阈结果）。 */
function buildLadderView(turnCount: number): LadderView {
  const messages: ViewMessage[] = [{ role: "compactionSummary", summary: BASE_TEXT }]
  const entries: ToolResultLadderEntry[] = []
  const toolIndexes: number[] = []
  for (let turn = 0; turn < turnCount; turn++) {
    messages.push({ role: "user", content: `第 ${turn + 1} 轮用户输入。` })
    messages.push({ role: "assistant", content: `第 ${turn + 1} 轮回复。` })
    const index = messages.length
    const address = `evt-result-${turn}`
    toolIndexes.push(index)
    entries.push({ index, toolName: TOOL_NAME, text: RAW_RESULT_TEXT, address })
    messages.push({ role: "toolResult", toolName: TOOL_NAME, content: RAW_RESULT_TEXT, details: { deskpetEntryId: address } })
  }
  return { messages, entries, toolIndexes }
}

/**
 * 合成 measure：与 runtime.ts `createLadderMeasure` 同形（system + 消息 + 工具 schema），
 * 消息侧按级别走**真投影函数**（级 0 = 地址标注，级 1/2 = `projectToolResultText`）。
 * 工具 schema 折算进底价正文，不另建一份 schema 夹具。
 */
function measureOf(messages: readonly ViewMessage[]): ToolResultLevelMeasure {
  return levels => estimateRequestTokens(SYSTEM_PROMPT, messages.map((message, index) => {
    if (message.role !== "toolResult") return message
    const text = String(message.content)
    const address = toolResultAddress(message)
    const level = levels.get(index)
    const content = level === undefined
      ? annotateToolResultText(text, address, TOOL_NAME)
      : projectToolResultText(text, address, WINDOW, TOOL_NAME, level)
    return { ...message, content }
  }), [])
}

function planOf(view: LadderView, protectedIndexes: ReadonlySet<number>): ReturnType<typeof planToolResultLadder> {
  return planToolResultLadder({
    entries: view.entries,
    measure: measureOf(view.messages),
    window: WINDOW,
    preserveToolNames: new Set(),
    protectedIndexes,
  })
}

// ==========================================
// 第三段：O-2 校准读数（K = N、N+1、N+2）
//
// 用常量推导三档，而不是写死 3/4/5：N 被 W6 裁定改值后，三档仍分别对应
// 「保护区内恰好装满 / 一条溢出 / 两条溢出」，读数的结构不变。
// ==========================================

const CALIBRATION_TURN_COUNTS: readonly number[] = [0, 1, 2].map(offset => LADDER_PROTECTION_TURNS + offset)

interface CalibrationReading {
  turns: number
  protectedCount: number
  outsideCount: number
  target: number
  tokensAfterLevel1: number
  tokensAfterLevel2: number
  level: 0 | 1 | 2
}

function readCalibration(turnCount: number): CalibrationReading {
  const view = buildLadderView(turnCount)
  // 与 runtime.ts:842 同一处接线：默认调用读常量。
  const protectedIndexes = protectedMessageIndexes(view.messages)
  const plan = planOf(view, protectedIndexes)
  return {
    turns: turnCount,
    protectedCount: view.toolIndexes.filter(index => protectedIndexes.has(index)).length,
    outsideCount: view.toolIndexes.filter(index => !protectedIndexes.has(index)).length,
    target: plan.target,
    tokensAfterLevel1: plan.tokensAfterLevel1,
    tokensAfterLevel2: plan.tokensAfterLevel2,
    level: plan.level,
  }
}

function formatReading(reading: CalibrationReading): string {
  const overTarget = reading.tokensAfterLevel2 - reading.target
  return `  K=${reading.turns} 轮：区内 ${reading.protectedCount} 条 / 区外 ${reading.outsideCount} 条`
    + ` | target=${reading.target} tokensAfterLevel1=${reading.tokensAfterLevel1}`
    + ` tokensAfterLevel2=${reading.tokensAfterLevel2} level=${reading.level}`
    + ` | 级 2 后相对 target ${overTarget >= 0 ? "+" : ""}${overTarget}`
    + (reading.tokensAfterLevel2 > HARD_LIMIT ? "（仍超硬上限，只能靠级 3/溢出恢复）" : "")
}

const CALIBRATION_READINGS: readonly CalibrationReading[] = CALIBRATION_TURN_COUNTS.map(readCalibration)

/** 打印用的规模口径：让读数自带「一条结果在各级下有多大」的参照。 */
function sizeReport(): string {
  const address = "evt-size"
  return `原文 ${estimateContextTokens(RAW_RESULT_TEXT)}`
    + ` / 级 1 ${estimateContextTokens(projectToolResultText(RAW_RESULT_TEXT, address, WINDOW, TOOL_NAME, 1))}`
    + ` / 级 2 ${estimateContextTokens(projectToolResultText(RAW_RESULT_TEXT, address, WINDOW, TOOL_NAME, 2))} tokens`
}

// ==========================================
// 场景
// ==========================================

export const 保护区口径: SceneDef = {
  meta: {
    caseId: "memory-ladder-protection-zone",
    module: "memory",
    contractId: "mm-32",
    description: "阶梯保护区的轮口径与 N 的校准读数：user/bashExecution 开轮、toolResult/assistant/custom/compactionSummary 不开轮，不足 N 轮全保护，turns<=0 才是关保护区；口径 B 下保护区内照进级 1 且恒不进级 2、区外进级 2；打印 K=N/N+1/N+2 的 tokensAfterLevel1/2 与区内/外条数（N 的最终值留给 W6 前用户裁定）",
    depth: "shallow",
    suite: "regression",
    entry: "unit",
    tags: ["memory", "compaction", "context", "boundary"],
  },
  turns: [{
    index: 1,
    description: "核对保护区轮口径、口径 B 的判定侧与 O-2 校准读数",
    userText: "核对阶梯保护区的轮口径与 N 的校准读数。",
    checks: [
      { type: "expectLadderProtectionZoneTurnSemantics", run: async () => {
        // O-2 的起步值：3。**这是价值钉，不是语义复述** —— 语义断言一律由常量推导
        // （下面所有 spec 的轮数、期望集合、三档 K 都不写 3），所以改常量时唯一红在这里，
        // 读数的三档会跟着常量走。W6 裁定 N 后，本行与常量、docs/current/memory.md 同批更新。
        if (LADDER_PROTECTION_TURNS !== 3) {
          throw new Error(`LADDER_PROTECTION_TURNS 的 O-2 起步值是 3，当前 ${LADDER_PROTECTION_TURNS}`
            + "；改这个旋钮要同批更新本场景与 docs/current/memory.md")
        }

        // 不足 N 轮 ⇒ 从第一条开轮消息起全保护。
        assertZone("不足 N 轮（1 轮）全保护", turnSpec())
        // 恰好 N 轮 ⇒ 仍全保护（边界：第 N 条开轮消息就是第一条）。
        assertZone(`恰好 N 轮（${LADDER_PROTECTION_TURNS}）全保护`, turnsSpec(LADDER_PROTECTION_TURNS))
        // N+1 轮 ⇒ 保护从第 2 条 user 起；区内消息恰为 N 轮（常量被读：硬编码 3 与常量不符时此处红）。
        const overflowSpec = turnsSpec(LADDER_PROTECTION_TURNS + 1)
        assertZone(`N+1 轮从第 2 条 user 起`, overflowSpec)
        const overflowZone = protectedMessageIndexes(messagesOf(overflowSpec))
        if (overflowZone.size !== MESSAGES_PER_TURN * LADDER_PROTECTION_TURNS) {
          throw new Error(`N+1 轮时保护区内应是 ${LADDER_PROTECTION_TURNS} 轮 = `
            + `${MESSAGES_PER_TURN * LADDER_PROTECTION_TURNS} 条消息，实际 ${overflowZone.size} 条`)
        }

        // custom（主动消息）与 compactionSummary 不开轮：它们落在「当前轮」内。
        // 若被当成轮首，边界会滑到它们身上、保护区缩小 —— 下面的期望集合立刻不等。
        assertZone("主动消息与摘要落在当前轮内（尾部 custom/compactionSummary）", [
          ...overflowSpec, ["custom", false], ["compactionSummary", false], ["toolResult", false],
        ])
        // 轮间（末轮之前）的 custom / compactionSummary 同样不开轮：它们若被当成轮首，
        // 边界会从第 2 条 user 滑到它们身上（下面的期望集合立刻不等）。
        assertZone("轮间的主动消息与摘要不开新轮", [
          ...turnsSpec(LADDER_PROTECTION_TURNS), ["custom", false], ["compactionSummary", false], ...turnSpec(),
        ])
        // 边界前的消息（首条开轮消息之前的历史）不进保护区。
        assertZone("首条开轮消息之前的内容不进保护区", [
          ["assistant", false], ["toolResult", false], ...overflowSpec,
        ])

        // bashExecution 开轮（与上游 compaction.js:245 对齐）：把它当不开轮会让边界前移一整轮。
        assertZone("bashExecution 开轮", [
          ...turnsSpec(LADDER_PROTECTION_TURNS), ["bashExecution", true], ["toolResult", false],
        ])

        // 边界：一条开轮消息都没有 / 空视图 ⇒ 空集。
        assertZone("没有开轮消息 ⇒ 空集", [["assistant", false], ["toolResult", false], ["custom", false], ["compactionSummary", false]])
        assertZone("空视图 ⇒ 空集", [])

        // turns <= 0 是关保护区的唯一方式：0 与负数都空集，而 1 不空（0 才是边界）。
        const nonTrivial = turnsSpec(LADDER_PROTECTION_TURNS + 1)
        assertZone("turns = 0 ⇒ 空集（关保护区的唯一方式）", nonTrivial, 0)
        assertZone("turns < 0 ⇒ 空集", nonTrivial, -1)
        if (protectedMessageIndexes(messagesOf(nonTrivial), 1).size === 0) {
          throw new Error("turns = 1 就关了保护区：关闭方式只能由 turns <= 0 触发")
        }

        // 默认参数 = 常量（同一批入参下逐项相等），且默认调用在 N+1 轮下保护 N 轮。
        const defaultZone = protectedMessageIndexes(messagesOf(overflowSpec))
        const explicitZone = protectedMessageIndexes(messagesOf(overflowSpec), LADDER_PROTECTION_TURNS)
        if ([...defaultZone].join(",") !== [...explicitZone].join(",")) {
          throw new Error("protectedMessageIndexes 的默认 turns 与 LADDER_PROTECTION_TURNS 不一致")
        }
      } },

      { type: "expectLadderKeepsProtectedEntriesAtLevel1", run: async () => {
        // 口径 B 的判定侧（C-1）：保护区只挡级 2，不挡级 1。
        const view = buildLadderView(LADDER_PROTECTION_TURNS + 1)
        const protectedIndexes = protectedMessageIndexes(view.messages)
        const protectedTools = view.toolIndexes.filter(index => protectedIndexes.has(index))
        const outsideTools = view.toolIndexes.filter(index => !protectedIndexes.has(index))
        if (protectedTools.length !== LADDER_PROTECTION_TURNS || outsideTools.length !== 1) {
          throw new Error(`合成视图的区内/区外条数不是 N/1：区内 ${protectedTools.length}、区外 ${outsideTools.length}`)
        }

        const plan = planOf(view, protectedIndexes)
        // 载荷非空性：级 1 之后确实超 target，否则走不到保护区这一步，下面的断言会退化成空转。
        if (plan.tokensAfterLevel1 <= TARGET) {
          throw new Error(`载荷不足：级 1 之后 ${plan.tokensAfterLevel1} 未超 target ${TARGET}，保护区未被触发`)
        }
        // 区内：在 levels 里且恒为 1 —— 同时挡住两种写错：
        // ① 口径 A（保护区在级 1 候选集里被排除 ⇒ get() === undefined）；
        // ② 保护区被误升到级 2（get() === 2）。
        for (const index of protectedTools) {
          const level = plan.levels.get(index)
          if (level !== 1) {
            throw new Error(`保护区内 idx=${index} 的级别是 ${level}（应为 1：口径 B 下照做级 1、永不进级 2）`)
          }
        }
        // 区外：有地址、不在保护区 ⇒ 全部进级 2。
        for (const index of outsideTools) {
          const level = plan.levels.get(index)
          if (level !== 2) {
            throw new Error(`保护区外 idx=${index} 的级别是 ${level}（应为 2：有地址且不在保护区的候选都该清空）`)
          }
        }
        if (plan.level !== 2 || ![...plan.levels.values()].includes(2)) {
          throw new Error(`plan.level=${plan.level}：区外有可清条目时应当升到级 2`)
        }
        if (plan.tokensAfterLevel2 >= plan.tokensAfterLevel1) {
          throw new Error("级 2 没有压小任何体积：读数应反映真实进展")
        }

        // 空集 = 显式「无保护」：同一批条目全部进级 2（区内那几条也不再被挡住）。
        const bare = planOf(view, new Set())
        for (const index of view.toolIndexes) {
          const level = bare.levels.get(index)
          if (level !== 2) throw new Error(`显式空集下 idx=${index} 的级别是 ${level}（应为 2：空集 ≠ 保护区）`)
        }
      } },

      { type: "expectSingleResultBudgetSharedByLevel1And2", run: async () => {
        // O-4：级 1 与级 2 共用同一个单条上限（唯一旋钮 toolResultTokenBudget）。
        // 恰好在上限的正文不进候选（级别 0）；多 1 token 就进（级 1）。
        const atBudget = "限".repeat(SINGLE_RESULT_BUDGET)
        const overBudget = `${atBudget}超`
        const messages: ViewMessage[] = [
          { role: "user", content: "核对单条上限。" },
          { role: "toolResult", toolName: TOOL_NAME, content: atBudget, details: { deskpetEntryId: "evt-at" } },
          { role: "toolResult", toolName: TOOL_NAME, content: overBudget, details: { deskpetEntryId: "evt-over" } },
        ]
        const atTokens = estimateContextTokens(atBudget)
        const overTokens = estimateContextTokens(overBudget)
        if (atTokens !== SINGLE_RESULT_BUDGET || overTokens !== SINGLE_RESULT_BUDGET + 1) {
          throw new Error(`夹具尺寸没踩在上限上：${atTokens} / ${overTokens}，单条上限 ${SINGLE_RESULT_BUDGET}`)
        }
        const view: LadderView = {
          messages,
          entries: [
            { index: 1, toolName: TOOL_NAME, text: atBudget, address: "evt-at" },
            { index: 2, toolName: TOOL_NAME, text: overBudget, address: "evt-over" },
          ],
          toolIndexes: [1, 2],
        }
        const plan = planOf(view, new Set())
        if (plan.target !== TARGET) throw new Error(`默认 target 不是 contextBudget(window).normalInputTarget：${plan.target}`)
        if (plan.levels.has(1)) throw new Error("恰好等于单条上限的结果被当成候选（应为级别 0）")
        if (plan.levels.get(2) !== 1) throw new Error(`超 1 token 的结果级别是 ${plan.levels.get(2)}（应为 1）`)
      } },

      { type: "expectLadderProtectionCalibrationReading", run: async () => {
        // O-2 的读数：**只打印 + 断言单调性**，不断言最优 N（N 由 W6 前用户裁定）。
        // 读数的持久渠道：本行日志（console + Rust 日志文件）与 T3.09 的任务报告。
        log.info("O-2 保护区校准读数（N=" + LADDER_PROTECTION_TURNS
          + "；底价=" + BASE_SHARE + "×target 的合成 compactionSummary，每轮 1 条超阈结果 "
          + `（${sizeReport()}））：`)
        for (const reading of CALIBRATION_READINGS) log.info(formatReading(reading))
        log.info(`  参照：target=${TARGET} hardInputLimit=${HARD_LIMIT} 单条 L0 上限=${SINGLE_RESULT_BUDGET}`
          + "；级 2 只能清保护区外的候选，区内条目停在级 1 体积")
        // 从读数本身推出的两个量：每多一轮（user + assistant + 级 1 后的结果）的成本，
        // 与「保护区最多锁死多少」。target→hard 的余量是硬上限能容忍的锁死上限。
        const perTurnLevel1 = CALIBRATION_READINGS[1].tokensAfterLevel1 - CALIBRATION_READINGS[0].tokensAfterLevel1
        log.info(`  推论：保护区最多锁死 ≈ N × 每轮级 1 体积 = ${LADDER_PROTECTION_TURNS} × ${perTurnLevel1}`
          + ` = ${LADDER_PROTECTION_TURNS * perTurnLevel1}；target→hard 余量 = ${HARD_LIMIT - TARGET}`
          + "（锁死体积超过余量时，级 2 用尽也回不到硬上限之下，只能靠级 3 摘要或溢出恢复）")

        for (let i = 1; i < CALIBRATION_READINGS.length; i++) {
          const previous = CALIBRATION_READINGS[i - 1]
          const current = CALIBRATION_READINGS[i]
          if (current.tokensAfterLevel1 <= previous.tokensAfterLevel1) {
            throw new Error(`K 越大级 1 之后该越大：K=${current.turns} 的 ${current.tokensAfterLevel1}`
              + ` 未超过 K=${previous.turns} 的 ${previous.tokensAfterLevel1}`)
          }
          if (current.tokensAfterLevel1 > current.target && current.level === 0) {
            throw new Error(`K=${current.turns} 的载荷超了 target 却停在级 0（无人可升）`)
          }
        }
      } },
    ],
  }],
}

export default 保护区口径
