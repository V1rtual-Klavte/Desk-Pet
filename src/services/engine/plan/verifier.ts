// ==========================================
// 计划级核验器 —— 独立只读子运行对照「原始目标」给出 pass | partial | fail
//
// 核验是只读的：它回答「原始目标是否达成」，与完成度（多少步 done）正交 ——
// 步骤自称 complete 不代表目标达成，完成度高也不等于通过。
// 核验失败、超时或结果无法解析一律按 partial 收束，永远不得冒充 pass；
// 返回 undefined 表示「本次没有核验」，同样不是通过。
// ==========================================

import { listAll } from "@/services/tool"
import { planConfig } from "@/services/config"
import { createLogger } from "@/services/logger"
import { formatError } from "@/services/error"
import type { PiSubAgentOutput, PiSubAgentScope } from "@/services/engine/state"
import type { PlanVerification } from "@/services/engine/protocol"
import { formatWorkOrder, parsePlanVerification } from "./work-order"
import type { PlanExecutionResult, PlanResult } from "../planner"

const log = createLogger("PlanVerifier")

// ── 核验预算（唯一一处）──
// 工具调用与时限按「只读核对」定档：核验比执行轻，但要看多个交付物，给 24 次调用足够。
const PLAN_VERIFY_MAX_TOOL_CALLS = 24
const PLAN_VERIFY_TIMEOUT_MS = 120_000
// 展示预算：核验只看结论与证据，整份产出塞进提示词会挤掉原始目标本身。
const PLAN_VERIFY_INTENT_BUDGET = 2000
const PLAN_VERIFY_WORK_ORDER_BUDGET = 2000
const PLAN_VERIFY_SUMMARY_BUDGET = 800
const PLAN_VERIFY_ITEM_BUDGET = 300
const PLAN_VERIFY_LIST_BUDGET = 1200
const PLAN_TRUNCATED_MARK = "…（已截断）"

export interface PlanVerificationInput {
  sessionId: string
  planId: string
  /** 用户原始请求或等价目标（与计划记录 `intent` 同源）。 */
  intent: string
  plan: PlanResult
  result: PlanExecutionResult
  /**
   * 核验子运行的取消/身份域。与执行同域，但 `isCurrent` 由调用方收窄为「回合代际仍有效」：
   * 核验是只读的，会话切换不取消计划（FIX-32）。
   */
  scope: PiSubAgentScope
}

/** 返回 undefined 表示「本次没有核验」（没有可核验的完成声明）；undefined 不是 pass。 */
export async function verifyPlanExecution(input: PlanVerificationInput): Promise<PlanVerification | undefined> {
  const { planId } = input
  // 跳过规则按顺序判断：没有步骤、或没有任何步骤声称完成时，不存在「假完成」风险，
  // 不花一次模型调用。注意不因 `overallSuccess === false` 跳过 —— 只要有完成声明就核验，
  // 核验结论要能解释计划为什么失败。恢复执行只剩 pending 步骤时，盘上已定档步骤的完成声明
  // 同样算数：前序工作也要接受核验，不因「本次没新完成什么」跳过。
  if (input.plan.steps.length === 0) {
    log.info("计划没有步骤，跳过核验:", planId)
    return undefined
  }
  if (!input.result.stepResults.some(item => item.outcome?.status === "complete")) {
    log.info("计划没有完成声明，跳过核验:", planId)
    return undefined
  }

  try {
    // 只读工具集：只保留注册表声明 `effect === "read"` 且能到达子代理的工具。
    // 派生型工具（isolation=delegate）由 runPiSubAgent 剥离，这里先剔除以免提示词夸大工具面；
    // 不传 `requiredToolNames` —— 核验缺某件工具只退化为「无法完全核实」，不该整体失败。
    const tools = listAll().filter(tool =>
      tool.policy.execution.isolation !== "delegate" && tool.policy.execution.effect === "read")
    // plan 层静态图只依赖 protocol/state（见 scripts/check-engine-layers.mjs），
    // 子代理内核按需加载（planner 同款先例）。
    const { runPiSubAgent } = await import("@/services/engine/harness/subagent")
    const output = await runPiSubAgent({
      task: "核对计划是否达成原始目标。",
      tools,
      systemPrompt: buildVerifierPrompt(input),
      outputContract: {
        kind: "text",
        validate: ({ reply }) => {
          if (!reply.trim()) return "核验没有返回结果"
          const parsed = parsePlanVerification(reply)
          return parsed.ok ? true : `核验结果不符合输出契约：${parsed.reason}`
        },
      },
      maxToolCalls: PLAN_VERIFY_MAX_TOOL_CALLS,
      deadlineAt: Date.now() + PLAN_VERIFY_TIMEOUT_MS,
      thinkingEffort: planConfig.thinkingEffort,
      owner: {
        ...input.scope,
        kind: "plan",
        runId: `plan-${planId}-verify-${crypto.randomUUID()}`,
        planId,
        stepId: "verify",
      },
      audit: { sessionId: input.sessionId, planId, stepId: "verify" },
      // 不传 onToolStart / onToolDone：checkpoint 没有 `verify` 步骤，写进去会产生悬空引用。
    })
    return mapVerification(output, planId)
  } catch (error) {
    // 核验异常绝不能把计划记录留在 running：如实按「未完成核验」收束。
    log.warn("计划核验异常，按部分通过收束:", planId, formatError(error))
    return unverified(formatError(error))
  }
}

// ── 展示辅助（planner 的同名函数是私有的，这里按核验自己的预算实现一份）──

function cap(text: string, budget: number): string {
  return text.length <= budget ? text : `${text.slice(0, budget)}${PLAN_TRUNCATED_MARK}`
}

/** 列表展示：逐条截断 + 总额封顶，放不下的整条省略并标注，不静默吞掉「还有缺口」。 */
function capList(items: readonly string[]): string {
  const parts: string[] = []
  let used = 0
  for (const item of items) {
    const text = cap(item, PLAN_VERIFY_ITEM_BUDGET)
    if (used + text.length > PLAN_VERIFY_LIST_BUDGET) {
      parts.push("…（其余已省略）")
      break
    }
    parts.push(text)
    used += text.length + 1
  }
  return parts.join("；")
}

/** 保留头 70% 与尾部：核验看结论常用尾部，只留开头会丢掉「最终是否达成」的判断依据。 */
function capHeadTail(text: string, budget: number): string {
  if (text.length <= budget) return text
  const content = Math.max(budget - PLAN_TRUNCATED_MARK.length, 0)
  const headLength = Math.ceil(content * 0.7)
  const tailLength = content - headLength
  return tailLength > 0
    ? `${text.slice(0, headLength)}${PLAN_TRUNCATED_MARK}${text.slice(-tailLength)}`
    : `${text.slice(0, headLength)}${PLAN_TRUNCATED_MARK}`
}

// ── 执行结果投影 ──

type StepResultEntry = PlanExecutionResult["stepResults"][number]
type BlockedEntry = PlanExecutionResult["blockedSteps"][number]
type StepRunState = "complete" | "partial" | "blocked" | "failed"

const RUN_STATE_LABELS: Record<StepRunState, string> = {
  complete: "完成",
  partial: "部分完成",
  blocked: "受阻",
  failed: "失败",
}

/** 执行归宿的唯一口径：与 planner 的 planStepStateOf 同源 —— 子运行没完成即 failed。 */
function runStateOf(entry: StepResultEntry): StepRunState {
  if (entry.output.status !== "completed" || entry.outcome === undefined) return "failed"
  return entry.outcome.status === "complete" ? "complete" : entry.outcome.status
}

/**
 * 一步的执行事实：状态映射是唯一口径 ——
 * complete/partial/blocked 取结构化产出；有结果但无产出（子运行失败）→ 失败并附错误；
 * 在 blockedSteps 里 → 未执行（依赖原因）；计划里有但本次没跑到 → 未执行。
 * 盘上旧条目与本次 blocked 可以并存（结果先落盘、步骤状态未定档就中断）：两件事都要写。
 */
function formatStepSection(
  step: PlanResult["steps"][number],
  entry: StepResultEntry | undefined,
  blocked: BlockedEntry | undefined,
): string {
  const lines = [
    // 标题也按单条预算截断：description 生成时没有长度上限，重复一次原文会把核验提示词撑大。
    `步骤 ${step.id}「${cap(step.description, PLAN_VERIFY_ITEM_BUDGET)}」`,
    "- 工作单:",
    cap(formatWorkOrder(step), PLAN_VERIFY_WORK_ORDER_BUDGET),
  ]
  if (entry) {
    const state = runStateOf(entry)
    lines.push(`- 执行: ${RUN_STATE_LABELS[state]}`)
    const outcome = entry.outcome
    if (outcome) {
      lines.push(`  - 摘要: ${capHeadTail(outcome.summary, PLAN_VERIFY_SUMMARY_BUDGET)}`)
      if (outcome.artifacts?.length) lines.push(`  - 交付物: ${capList(outcome.artifacts)}`)
      if (outcome.evidence?.length) lines.push(`  - 证据: ${capList(outcome.evidence)}`)
      for (const check of outcome.acceptance?.filter(item => !item.met) ?? []) {
        const note = check.note ? `（${cap(check.note, PLAN_VERIFY_ITEM_BUDGET)}）` : ""
        lines.push(`  - 验收未达成: ${cap(check.item, PLAN_VERIFY_ITEM_BUDGET)}${note}`)
      }
      if (outcome.missing?.length) lines.push(`  - 缺口: ${capList(outcome.missing)}`)
      if (outcome.needs?.trim()) lines.push(`  - 需要: ${capHeadTail(outcome.needs, PLAN_VERIFY_SUMMARY_BUDGET)}`)
    }
    // 错误只在没有产出或该步失败时给：产出已定档时 error 只是同一结论的中性摘要。
    if (state === "failed" && entry.output.error) {
      lines.push(`  - 错误: ${capHeadTail(entry.output.error, PLAN_VERIFY_SUMMARY_BUDGET)}`)
    }
    if (blocked) lines.push(`- 本次未执行（${capHeadTail(blocked.reason, PLAN_VERIFY_SUMMARY_BUDGET)}）`)
  } else if (blocked) {
    lines.push(`- 执行: 未执行（${capHeadTail(blocked.reason, PLAN_VERIFY_SUMMARY_BUDGET)}）`)
  } else {
    lines.push("- 执行: 未执行（本次执行没有跑到这一步）")
  }
  return lines.join("\n")
}

function buildVerifierPrompt(input: PlanVerificationInput): string {
  const resultsByStep = new Map(input.result.stepResults.map(entry => [entry.step.id, entry]))
  const blockedByStep = new Map(input.result.blockedSteps.map(blocked => [blocked.step.id, blocked]))
  // 按计划 id 升序展示：阅读顺序与执行顺序一致，不按结果到达顺序。
  const stepBlocks = [...input.plan.steps]
    .sort((a, b) => a.id - b.id)
    .map(step => formatStepSection(step, resultsByStep.get(step.id), blockedByStep.get(step.id)))

  return [
    "你是计划核验器。只读核对「计划实际产出」是否达成「原始目标」；不执行计划、不修改任何内容。",
    "",
    "## 原始目标",
    capHeadTail(input.intent, PLAN_VERIFY_INTENT_BUDGET),
    "",
    "## 计划与执行结果",
    ...stepBlocks,
    "",
    "## 核验要求",
    "- 以原始目标为准，不以计划摘要或步骤自述为准；步骤自称 complete 不代表目标达成。",
    "- 只依据执行结果与你能用只读工具核实的证据下结论；不要补造事实。",
    "- verdict：pass（原始目标已达成）/ partial（有实质产出但目标只部分达成或无法完全核实）/ fail（目标未达成或产出与目标不符）。",
    "- drift 写实际执行偏离原始目标之处；missing 写达成目标还缺什么；reasons 写结论依据。",
    "- 只使用只读工具；不要修改文件、不要执行有副作用的操作。",
    "",
    "## 输出契约",
    "最终回复只输出一个 JSON 对象，字段：verdict（pass|partial|fail）、reasons（字符串数组）、",
    "missing（字符串数组）、drift（字符串数组）、summary（字符串）。不要在 JSON 外写解释。",
  ].join("\n")
}

// ── 结果映射（确定性，不抛异常）──

/** 没有核验结论时的唯一归宿：partial + 原因，绝不冒充 pass。 */
function unverified(reason: string): PlanVerification {
  return {
    verdict: "partial",
    reasons: [reason],
    missing: [],
    drift: [],
    summary: `计划核验未完成：${reason}`,
  }
}

function mapVerification(output: PiSubAgentOutput, planId: string): PlanVerification {
  if (output.status !== "completed") {
    const detail = output.error ? `: ${output.error}` : ""
    log.warn("核验子代理未完成:", planId, output.status, output.error ?? "")
    return unverified(`核验子代理未完成（${output.status}${detail}）`)
  }
  if (output.reply.trim() === "") {
    log.warn("核验没有返回结果:", planId)
    return unverified("核验没有返回结果")
  }
  const parsed = parsePlanVerification(output.reply)
  if (!parsed.ok) {
    log.warn("核验结果不符合输出契约:", planId, parsed.reason)
    return unverified(`核验结果不符合输出契约：${parsed.reason}`)
  }
  // 确定性降级只影响 pass：证据不闭环或工具预算耗尽时，「通过」不能算通过。
  const downgradeReasons: string[] = [
    ...output.evidence.incomplete,
    ...(output.evidence.toolBudgetExhausted === true ? ["核验工具调用预算耗尽"] : []),
  ]
  const reasons = [...parsed.value.reasons, ...downgradeReasons]
  const downgraded = parsed.value.verdict === "pass" && downgradeReasons.length > 0
  if (downgraded) {
    log.warn("核验自称通过但证据不闭环，已降级为部分通过:", planId, downgradeReasons.join("；"))
  }
  return {
    verdict: downgraded ? "partial" : parsed.value.verdict,
    reasons,
    missing: parsed.value.missing,
    drift: parsed.value.drift,
    summary: parsed.value.summary,
  }
}
