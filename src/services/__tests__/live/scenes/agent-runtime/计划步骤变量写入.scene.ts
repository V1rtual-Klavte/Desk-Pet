// ==========================================
// Live Test Scene: 计划回合的 RUNTIME_DATA 变量写入（源项 FIX-10 / 覆盖点 ar-16）
// ==========================================
//
// 把「assistant 带 toolCall 且回复末尾带 RUNTIME_DATA 的回合，变量到底写没写」变成可判定的事实。
// 结算取 `state.finalPlainAssistant ?? state.finalAssistant`，而 afterResponse 的
// `recordSettledReply` 是按消息覆盖的（`runtime.ts`）—— 两条断言因此分开写：
//   B（步骤子代理）：子代理结算路径不解析变量（PLAN-09 的设计），原始正文随
//      `deskpet.plan_step_result` 留证，且不得改变量池；
//   A（主回合）：主回合最终回复的 RUNTIME_DATA 必须写进变量池并可回读。
// 顺序是 B 先跑：只有计划真跑起来了、步骤产出留了证，A 的「写没写」才有意义。
//
// provider 的响应队列顺序就是逐次请求的顺序（faux provider 按队列交付）：
//   1. 计划生成（`completePiText`）→ 计划 JSON（1 步，步内只给 live 工具）；
//   2. 步骤子代理第 1 轮 → 工具调用（TOOL_NAME）；
//   3. 步骤子代理第 2 轮 → 最终回复带 RUNTIME_DATA（被剥离，原始正文进 plan_step_result）；
//   4. 主回合第 1 轮 → 工具调用（TOOL_NAME）；
//   5. 主回合第 2 轮 → 最终回复带 RUNTIME_DATA（断言 A 的写入来源）。
// 注意第 1 条：计划生成本身也是一次 provider 请求，不先喂计划 JSON 就会拿到空计划，
// 计划段直接跳过（原任务草案的 3 条响应脚本缺这一条）。
//
// ⚠️ 断言 A 的实测结论（FIX-10 / T2.14）：
//    A **不成立**，但不成立的原因不是「带 toolCall 回合的 RUNTIME_DATA 被静默丢弃」，而是
//    这条断言读的是**生产入口拿不到的投影**：`ctx.output.runtimeData` 只在 `entry: "runtime"`
//    的路径上存在（`executeTurn` 直接返回 `runPiAgentTurn` 的输出）；`entry: "production"` 走
//    `sendMessage()`，其 `SendMessageResult` 不带 runtimeData（消费方是变量池，不是宿主），
//    `executeTurn` 的 production 分支也没有构造它 —— 于是 `ctx.output.runtimeData` 恒为
//    undefined，与「变量到底写没写」无关。实测（W2/W5 两轮）失败点都停在这里，池与 stages
//    两条子断言根本没被执行过。
//    处置：A 改按**可观测的写入事实**判（展示正文无协议块 + 变量池值/updatedBy + stages 回读），
//    不再断言解析投影；FIX-10 的「变量静默丢失」假设按现有源码与上游实跑探针不成立
//    （结算取 `state.finalPlainAssistant ?? state.finalAssistant`，带 toolCall 的过程消息不进
//    结算，最终无 toolCall 的回复仍经 afterResponse 留底的原始正文配对解析），不需要改结算逻辑。
//    场景头部的 B 断言（步骤子代理不写变量、原始正文留证）保持不变。

import { initChat } from "@/services/agent/runner"
import { PLAN_STEP_RESULT_ENTRY, type PlanStepResult } from "@/services/agent/memory"
import { planConfig, setOverride } from "@/services/config"
import { getActiveCard, listPersonalities, switchPersonality } from "@/services/personality/registry"
import { readStagesFile } from "@/services/personality/stages-file"
import type { CardVariableDef, PersonalityCard } from "@/services/personality/types"
import { getPoolSnapshot } from "@/services/personality/variable-pool"
import { getActiveSessionId } from "@/services/session"
import { readPiSessionEntriesOnce } from "@/services/session/repo"
import { registerBlockingTool } from "../../blocking-tool"
import { fakeText, fakeToolCall, installFakeProvider } from "../../fake-provider"
import type { AssertCheck, SceneDef } from "../../types"

const TOOL_NAME = "live_plan_write_tool"
const USER_TEXT = "--plan 帮我分析一下配置文件"
/** 主回合载荷值：断言 A 的期望值。 */
const MAIN_VALUE = "计划写入值"
/** 步骤载荷值：只允许出现在 plan_step_result 里，不得进变量池。 */
const STEP_VALUE = "步骤写入值"
/** 主回合脚本的可见正文：剥离协议块后就是展示正文（断言 A 的展示口径）。 */
const REPLY_TEXT = "计划完成啦"
/** 步骤子代理脚本的可见正文：只随 plan_step_result 留证，不参与展示断言。 */
const STEP_REPLY_TEXT = "步骤做完了"

let targetVar: CardVariableDef | undefined
/** 回合前的 card 段投影：断言 B 用它证明「除 A 允许的那次写入外没有别的变量变化」。 */
let poolBefore: Record<string, string> = {}
let blocking: ReturnType<typeof registerBlockingTool> | undefined
// 原值只捕获一次：上一 trial 若在清理前失败，不能把本场景自己设的测试值当成「原值」记下来。
let planEnabledBefore: boolean | undefined

/** card 段的「名字 → 类型 + 值」投影；用 JSON 区分 false 与 "false"。 */
function cardValues(): Record<string, string> {
  const values: Record<string, string> = {}
  for (const [name, state] of Object.entries(getPoolSnapshot().card)) {
    values[name] = `${state.type}:${JSON.stringify(state.value)}`
  }
  return values
}

/**
 * 激活 Card 上真实注册、允许 LLM 写入、值域不受 enum 限制的 card 段字符串变量。
 * 变量名只能来自 Card 的 variableDefs，不得臆造；名字里带冒号会让 `名字: 值` 行格式解析不出来。
 */
function findWritableStringVar(card: PersonalityCard | null): CardVariableDef | undefined {
  return card?.sections.variableDefs.find(def =>
    def.scope === "card" && def.type === "string" && def.updateBy === "llm"
    && !def.enum && !def.name.includes(":"))
}

/** 步骤产出证据（PLAN-09②）：按 customType 收窄读回父会话条目。 */
async function stepResults(sessionId: string): Promise<PlanStepResult[]> {
  const results: PlanStepResult[] = []
  for (const entry of await readPiSessionEntriesOnce(sessionId, { customType: PLAN_STEP_RESULT_ENTRY, order: "asc" })) {
    if (entry.type !== "custom") continue
    results.push(entry.data as unknown as PlanStepResult)
  }
  return results
}

/** 计划 JSON：1 步，步内只给 live 工具（allow 默认的工具，不需要确认）。 */
function planJson(): string {
  const plan = {
    summary: "分析配置文件",
    steps: [{ id: 1, description: "读取并汇总配置文件", role: "文件分析员", allowedTools: [TOOL_NAME] }],
    estimatedComplexity: 3,
  }
  return ["```json", JSON.stringify(plan), "```"].join("\n")
}

function runtimeDataBlock(name: string, value: string): string {
  return `<RUNTIME_DATA>\n${name}: ${value}\n</RUNTIME_DATA>`
}

/** 只在断言阶段清理：注销工具 + 恢复配置（setOverride 会连带写盘，不能把测试值留在配置里）。 */
function cleanup(): void {
  blocking?.dispose()
  blocking = undefined
  if (planEnabledBefore !== undefined) setOverride("ai.plan.enabled", planEnabledBefore)
}

/** 断言 B：步骤子代理的 RUNTIME_DATA 不写变量，但原始正文必须留证（PLAN-09④）。 */
const expectStepRawEvidence: AssertCheck = {
  type: "expectStepRawEvidence",
  run: async () => {
    try {
      const results = await stepResults(getActiveSessionId())
      if (results.length === 0) {
        throw new Error("没有 deskpet.plan_step_result 条目：计划没有跑起来，或步骤产出没落盘")
      }
      const step = results[0]!
      if (!step.reply) throw new Error("步骤产出证据缺少 reply 正文")
      if (!step.success) throw new Error(`步骤子代理未成功: ${step.error ?? "（无错误信息）"}`)
      if (step.toolCallsMade < 1) {
        throw new Error(`步骤子代理没有工具调用（toolCallsMade=${step.toolCallsMade}），本场景「带 toolCall 的回合」前提不成立`)
      }
      // 留证的是**被剥离的原始正文**：RUNTIME_DATA 块与载荷值都必须还在
      if (!step.reply.includes("<RUNTIME_DATA>") || !step.reply.includes(STEP_VALUE)) {
        throw new Error(`plan_step_result 没有保留被剥离的原始正文: ${step.reply}`)
      }
      // 子代理不写变量（PLAN-09 的设计：只有主回合写变量）：除断言 A 允许的那次写入外，
      // card 段不允许出现任何变化 —— 步骤载荷值尤其不能出现在任何变量里。
      const allowed = targetVar ? `${targetVar.type}:${JSON.stringify(MAIN_VALUE)}` : ""
      for (const [name, value] of Object.entries(cardValues())) {
        if (value === poolBefore[name]) continue
        if (name === targetVar?.name && value === allowed) continue
        throw new Error(`变量池出现非预期变化: ${name}=${value}（步骤载荷值 ${STEP_VALUE} 不该写进任何变量）`)
      }
    } finally {
      cleanup()
    }
  },
}

/**
 * 断言 A：主回合（带 toolCall）的最终回复带 RUNTIME_DATA → 变量被写入，且 stages 文件可回读。
 *
 * 观测面：生产入口只回传「用户看得见/可回读」的事实（展示正文、变量池、stages 文件）；
 * 解析投影（`runtimeData.variables`）是引擎内部中间量，`SendMessageResult` 不带它，
 * 因此这里按写入事实判 —— 写入只可能来自那次解析，两者不是彼此独立的证据。
 */
const expectMainTurnWrite: AssertCheck = {
  type: "expectMainTurnWrite",
  run: async (ctx) => {
    // 前提：主回合确实调用过工具，否则这条断言对 FIX-10 没有意义
    if (!ctx.toolHistory.some(item => item.toolName === TOOL_NAME)) {
      throw new Error(`主回合没有调用 ${TOOL_NAME}，「带 toolCall 的回合」前提不成立: ${JSON.stringify(ctx.toolHistory)}`)
    }
    const def = targetVar
    if (!def) throw new Error("场景 setup 没有选出变量（setup 本应先失败）")
    // 协议块没有泄漏进展示正文，且展示正文就是脚本正文去掉协议块后的样子（剥离发生在展示之前）
    if (ctx.output.reply.includes("RUNTIME_DATA")) throw new Error(`RUNTIME_DATA 块泄漏进了展示正文: ${ctx.output.reply}`)
    if (!ctx.output.reply.includes(REPLY_TEXT)) {
      throw new Error(`主回合的展示正文不含脚本正文: ${JSON.stringify(ctx.output.reply)}`)
    }

    const state = getPoolSnapshot().card[def.name]
    if (state?.value !== MAIN_VALUE) throw new Error(`变量池未写入: ${def.name}=${String(state?.value)}（期望 ${MAIN_VALUE}）`)
    if (state.updatedBy !== "llm") throw new Error(`${def.name} 的 updatedBy=${state.updatedBy}，应为 llm`)

    // 磁盘回读：stages/{cardId}.json 的 variables 段（持久化不在内存里自证）
    const cardId = getActiveCard()?.id
    if (!cardId) throw new Error("没有激活的 Card，无法回读 stages 文件")
    const file = await readStagesFile(cardId)
    const persisted = file?.variables?.card?.[def.name]?.value
    if (persisted !== MAIN_VALUE) throw new Error(`stages 文件回读不一致: ${String(persisted)}（期望 ${MAIN_VALUE}）`)
  },
}

export const 计划步骤变量写入: SceneDef = {
  meta: {
    caseId: "runtime-plan-step-variable-write",
    module: "agent-runtime",
    contractId: "ar-16",
    description: "计划回合的 RUNTIME_DATA：主回合（带 toolCall）写入变量并可回读，步骤子代理不写变量、原始正文随 plan_step_result 留证",
    depth: "deep",
    suite: "regression",
    entry: "production",
    planPolicy: "auto",
    tags: ["plan", "runtime-data", "variable", "production-entry", "tool", "boundary"],
  },
  setup: async () => {
    // 变量名来自 Card 定义，而激活 Card 取决于当前用的是哪份配置 ——
    // 激活 Card 没有可写的 card 段字符串变量时，按 variable-pool/亲密度提升.scene.ts 的先例
    // 切到定义了该变量的 Card；任何 Card 都没有就显式失败，不臆造变量名。
    targetVar = findWritableStringVar(getActiveCard())
    if (!targetVar) {
      const target = listPersonalities().find(card => findWritableStringVar(card))
      if (!target) throw new Error("没有任何 Card 定义可写入的 card 段字符串变量，场景无法执行")
      const switched = await switchPersonality(target.id)
      if (!switched.ok) throw new Error(`切换到 Card ${target.id} 失败: ${switched.error ?? "未知原因"}`)
      targetVar = findWritableStringVar(getActiveCard())
    }
    if (!targetVar) throw new Error("切换后仍找不到可写入的 card 段字符串变量")

    // 计划段只看 planConfig.enabled（基线把它钉在 false）；显式打开让场景不依赖用户配置。
    // 原值在首个断言里恢复 —— setOverride 会连带写盘，不能把测试值留在开发配置里。
    planEnabledBefore ??= planConfig.enabled
    setOverride("ai.plan.enabled", true)

    const name = targetVar.name
    installFakeProvider([
      fakeText(planJson()),
      fakeToolCall(TOOL_NAME, {}, "plan-step-call"),
      fakeText(`${STEP_REPLY_TEXT} ${runtimeDataBlock(name, STEP_VALUE)}`),
      fakeToolCall(TOOL_NAME, {}, "main-turn-call"),
      fakeText(`${REPLY_TEXT} ${runtimeDataBlock(name, MAIN_VALUE)}`),
    ])
    await initChat()

    blocking = registerBlockingTool(TOOL_NAME)
    // 工具只在窗口内阻塞：started 一到就放行（场景不测取消，卡在工具上会让场景超时）。
    // 步骤子代理与主回合各调用一次，`released` 一旦置位对两次调用都立即放行。
    void blocking.started.then(() => blocking?.release())

    // 会话初始化可能触发变量游标重置，快照必须在 initChat 之后取
    poolBefore = cardValues()
  },
  turns: [{
    index: 1,
    description: "计划（1 步）+ 主回合各带一次工具调用，核对 RUNTIME_DATA 的写入与留证",
    userText: USER_TEXT,
    checks: [expectStepRawEvidence, expectMainTurnWrite],
  }],
}

export default 计划步骤变量写入
