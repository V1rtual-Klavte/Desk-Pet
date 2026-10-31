// 结构化摘要的 before_compaction 钩子与级 3 闸门装配（与投影共用同一份额度/地址目录）。
// 纯搬移自 harness/runtime.ts（T1.5 抽出 harness 原语），不改变行为。

import { createCompactionSummaryMessage } from "@earendil-works/pi-agent-core"
import type { AgentMessage, CompactResult, CompactionPreparation } from "@earendil-works/pi-agent-core"
import { estimateRequestTokens, protectedMessageIndexes } from "@/services/context"
import type { ToolResultLevelMeasure } from "@/services/context"
import type { StructuredSummary } from "@/services/engine/compaction/structured-summary"
import { createPromptRewrite } from "@/services/engine/protocol"
import type { CompactionAuditSink, CompactionDeclineKind, CompactionDeclineRecord } from "@/services/engine/protocol"
import type { HarnessRunHooks } from "@/services/engine/state"
import { formatError } from "@/services/error"
import { createLogger } from "@/services/logger"
import { findRetainedToolCall, preservedToolNames, retainedToolNames } from "@/services/tool"
import type { ToolDef } from "@/services/tool"
import { describeCompactionFailure, ladderGate, summarizeCompaction } from "../compactor"
import type { LadderGateInput } from "../compactor"
import { applyLevels, isCompletedEmptyAssistant, toolResultLadderEntries } from "./message-adapters"
import type { PiModel } from "./model-gateway"

// 日志分类沿用原 runtime.ts 的 PiRuntime：纯搬移，不改日志口径。
const log = createLogger("PiRuntime")

// ── 级 3 闸门的消息形态适配（T3.05）：级 1/2 是纯函数、零成本，压完装得下就不花摘要调用 ──
//
// 判定核在 compactor.ts 的 `ladderGate()`。本文件只负责「Pi 消息形态」这一侧的装配：
// entries / measure / 保护区。消息形态适配器只有 `toolResultLadderEntries` 与 `applyLevels` 一份
// （T3.03 的产出），投影 hook 与闸门共用 —— `compactor.ts` 不抽同名实现：它反向 import 本文件会成环。

/** 级 3 闸门的视图：压缩覆盖范围拼出的 Pi 消息数组（不引入新形态，仍是 AgentMessage）。 */
type PiView = readonly AgentMessage[]

/**
 * 闸门的视图：与 Harness 提交摘要时的覆盖范围同源（`prepareCompaction` 的三段拼接，
 * `compaction.js:441-463`）—— previousSummary 存在时前置一条 compactionSummary 消息
 * （估算的角色表已覆盖它，见 budget.ts 的 `MESSAGE_CONTENT_PROJECTION`），再接
 * `messagesToSummarize + turnPrefixMessages + retainedTail`：时间序、无重叠，三段相加即这次
 * 压缩覆盖的全部消息。
 *
 * 与真实请求视图的差量只有「检查点同时落位的 lane inbox 消息」，量级是单条用户输入：
 * 判 false 的方向是照常摘要（照现状），判 true 的方向是本次不摘要且下一个检查点重算，
 * 偏差自愈，不会卡死在错的一侧（§1.5）。
 */
function compactionGateView(preparation: CompactionPreparation): PiView {
  return [
    // 时间戳不参与估算（`estimateMessageTokens` 不计时间戳），这里只补齐上游消息形态。
    ...(preparation.previousSummary === undefined
      ? []
      : [createCompactionSummaryMessage(preparation.previousSummary, preparation.tokensBefore, Date.now())]),
    ...preparation.messagesToSummarize,
    ...preparation.turnPrefixMessages,
    ...preparation.retainedTail,
  ]
}

/**
 * 地址目录 thunk 的唯一取值点（投影 hook 与级 3 闸门共用）：读取失败不让调用方失败 ——
 * 退化为「无前缀」（地址退回完整条目 id，完整 id 永远可读，A-4），留痕一次。
 * `where` 只用来分辨调用点，两处的兜底语义一致。
 */
export async function readAddressRefs(
  addressRefs: (() => Promise<ReadonlyMap<string, string>>) | undefined,
  where: string,
): Promise<ReadonlyMap<string, string> | undefined> {
  if (!addressRefs) return undefined
  return addressRefs().catch(error => {
    log.warn(`地址目录读取失败，${where}退回完整条目 id:`, formatError(error))
    return undefined
  })
}

/**
 * 阶梯 measure 的唯一构造点（投影 hook 与级 3 闸门共用同一个实现）：
 * systemPrompt / tools / 消息形态与地址目录都关在这个闭包里，两处不可能各拼一份判据。
 *
 * 必须是纯函数闭包（规划器最多调 3 次，`ToolResultLevelMeasure` 的要求）；读数恒等于
 * 「按 levels 投影后的请求视图」—— 分级后的视图走 `applyLevels`（投影的唯一实现）。
 */
export function createLadderMeasure(args: {
  systemPrompt: string
  view: PiView
  model: PiModel
  preserveToolNames: ReadonlySet<string>
  tools: readonly ToolDef[]
  addressRefs?: ReadonlyMap<string, string>
  /** 与投影同一份循环软提示：读数才有权声称「恒等于最终请求视图」。 */
  toolLoopNotices?: ReadonlyMap<string, string>
}): ToolResultLevelMeasure {
  return levels => estimateRequestTokens(
    args.systemPrompt,
    applyLevels(args.view, levels, args.model.contextWindow, args.preserveToolNames, args.addressRefs, args.toolLoopNotices),
    args.tools,
  )
}

/**
 * 级 3 闸门构造器的唯一实现（两个调用点共用）：把视图 + 投影同一份地址目录装配成
 * `LadderGateInput` —— entries、measure、保护区都走投影 hook 的同一份实现与同一份名单。
 * 工具面与 preserve 名单由调用方按各自的投影 hook 传入（回合路径是冻结工具集，
 * 结构操作是空工具面），闸门估的就是那条路径的投影会做的那件事。
 */
export function createLadderGateBuilder(args: {
  systemPrompt: string
  model: PiModel
  tools: readonly ToolDef[]
  preserveToolNames: ReadonlySet<string>
  toolLoopNotices?: ReadonlyMap<string, string>
}): (view: PiView, addressRefs?: ReadonlyMap<string, string>) => LadderGateInput {
  return (view, addressRefs) => ({
    entries: toolResultLadderEntries(view, addressRefs),
    measure: createLadderMeasure({
      systemPrompt: args.systemPrompt, view, model: args.model,
      preserveToolNames: args.preserveToolNames, tools: args.tools, addressRefs,
      toolLoopNotices: args.toolLoopNotices,
    }),
    window: args.model.contextWindow,
    preserveToolNames: args.preserveToolNames,
    // 保护区与主请求同一份口径（口径 B：只挡级 2），不是闸门里的第二道过滤。
    protectedIndexes: protectedMessageIndexes(view),
  })
}

/**
 * 结构化摘要的 before_compaction 钩子；主回合与手动 /compact 共用同一内核（H-3/§7）。
 *
 * **X-4（本函数的核心不变量）：只有两种结局 —— 成功产出恰好一个 `compaction`，其余一律
 * `{ decline: true }`。** 返回路径穷举（全部落在下面的 try/catch 内，本函数没有别的出口）：
 * ① 没有可摘要范围、② 覆盖范围含 retain 保护调用 → decline（都不是失败，不写 audit）；
 * ③ 阈值压缩的级 3 闸门判定「级 1/2 压完装得下」→ decline（策略性不花 LLM，同样不写 audit）；
 * ④ 宿主摘要内核成功 → 恰好一条 `compaction`（提交是上游收到它之后的单事务，宿主没有第二条提交路径）；
 * ⑤ catch：内核抛错/被取消 → 唯一带原因文案的 decline。
 *
 * **红线：失败必须走 decline，绝不把异常抛回上游。** 上游 `HookRegistry.firstStructural`
 * （`pi-agent-core/dist/harness/hooks.js`）对抛出的处理器只记 handler_error 就继续，于是
 * `runStructuralDecision` 落到 `publishStructuralReady`（`harness/runtime/drive/structural.js`）
 * —— 那是上游自己的摘要效应：用它的通用英文提示词（`compaction.js` 的 `SUMMARIZATION_SYSTEM_PROMPT`）
 * 重新摘要。那条路径不受本方案的地址目录与投影阶梯约束，产出的摘要却会提交成后续所有回合唯一的
 * 历史视图且不可回滚：用户以为压缩成功，用的却是另一套语义。宁可不压缩。
 * 同理**不得返回 `undefined`**（空返回）：`slot.ts` 的 before_compaction 桥接里那条
 * `if (!host)` 早退是上游唯一的兜底入口 —— 宿主一旦空返回，等于放行上游摘要。
 *
 * 失败的可见面（现状口径，改那条接线不属本函数职责）：decline 在上游的 `declined` 终态里**不带
 * error**，原因只走审计槽与日志 —— 内核失败写 `options.audit.failure`（槽在 `compaction_end` 收口成
 * `deskpet.compaction_declined` 条目的 `error` 字段；回合路径没有用户可见行，手动 `/compact` 由
 * `compactActiveSession` 读同一审计槽把 declined 重标为 failed 才带上原因）与下面的 `log.error`；
 * 策略性拒绝（素材为空 / 保留守卫 / 闸门）写 `options.audit.decline`（结构化 kind/trigger/数字，
 * 槽按触发方式落条目或只留日志）与一条统一的 decline 日志 —— pi 的 declined 不带原因，这里不写就没人写。
 */
export function createCompactionHook(options: {
  model: PiModel
  tools: readonly ToolDef[]
  /** 压缩请求的归属会话；一次性摘要请求的快照与派生记录按它落盘。 */
  sessionId?: string
  /**
   * 级 3 闸门估算所需的系统前缀（调用方冻结的 systemPrompt）。缺失 ⇒ 不跑闸门、照常摘要：
   * 宁可花一次 LLM，也不按缺了系统前缀的估算误判「装得下」（§1.5 的保守方向）。
   */
  systemPrompt?: string
  /**
   * 级 3 闸门的构造器（`createLadderGateBuilder` 的产出）：hook 用「当次压缩覆盖范围」的视图
   * 与投影同一份地址目录调它。缺失（如子代理不投影工具结果）⇒ 不跑闸门、照常摘要。
   */
  buildGate?: (view: PiView, addressRefs?: ReadonlyMap<string, string>) => LadderGateInput
  onSummary?: (summary: StructuredSummary) => void
  /** 宿主摘要内核失败（decline 原因）；调用方据此给出可见失败与审计。 */
  audit?: CompactionAuditSink
  onFailure?: (reason: string) => void
  /**
   * 地址目录 thunk，与投影 hook 是**同一份来源**（`slot.addressRefs()`），摘要素材的地址前缀
   * 因此与主请求对同一结果逐字相同。这里只透传、不提前取值 —— 阈值压缩发生在回合中途，
   * 构造期取到的目录不含本回合刚产生的工具结果，会让它们退回完整 id 而破坏「逐字相同」。
   */
  addressRefs?: () => Promise<ReadonlyMap<string, string>>
}): NonNullable<HarnessRunHooks["beforeCompaction"]> {
  const retained = retainedToolNames(options.tools)
  const preserved = preservedToolNames(options.tools)
  // 返回类型显式收窄到「两种结局」（不含空返回）：日后再加一条空返回就编译不过 ——
  // X-4 的「没有兜底出口」由类型保证，不靠注释维持。
  return async ({ reason, preparation, signal, runId }): Promise<{ decline: true } | { compaction: CompactResult }> => {
    /**
     * 记一次策略性 decline：结构化原因写进可注入的审计槽（槽按触发方式落条目），并返回给调用点
     * 留一条统一日志。pi 的 declined 终态不带 error —— 钩子不在这里留痕，这次拒绝就从日志与审计面
     * 同时消失（2026-10-05 实测：44 条会话因素材为空被拒，会话文件与三份日志都是 0 条，原因无从查起）。
     */
    const noteDecline = (
      kind: CompactionDeclineKind,
      fields: Omit<CompactionDeclineRecord, "kind" | "trigger" | "sessionId">,
    ): CompactionDeclineRecord => {
      const record: CompactionDeclineRecord = {
        kind, trigger: reason,
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        ...fields,
      }
      if (options.audit) options.audit.decline = record
      return record
    }
    try {
      // Keep the JSONL range intact, but omit empty completed silence rows from the summary model's view.
      const summaryPreparation = {
        ...preparation,
        messagesToSummarize: preparation.messagesToSummarize.filter(message => !isCompletedEmptyAssistant(message)),
        turnPrefixMessages: preparation.turnPrefixMessages.filter(message => !isCompletedEmptyAssistant(message)),
      }
      // 结局①（decline）：全量都在保留窗口内时没有可安全摘要的覆盖范围，让 Harness 原样收尾。
      if (!summaryPreparation.messagesToSummarize.length && !summaryPreparation.turnPrefixMessages.length) {
        // 这条拒绝过去完全静默（pi 不带 error、钩子不写 failure、槽因此不落条目），是「一句话都不留」的根因。
        log.info("压缩被拒绝（decline）：摘要素材为空，没有可安全摘要的覆盖范围:", noteDecline("empty_material", {
          material: {
            messagesToSummarize: summaryPreparation.messagesToSummarize.length,
            turnPrefixMessages: summaryPreparation.turnPrefixMessages.length,
            // 过滤「无正文已完结助手」丢掉了几条：>0 说明素材曾经非空，是滤空的而不是切点没给出范围。
            droppedEmptyAssistant: preparation.messagesToSummarize.length + preparation.turnPrefixMessages.length
              - summaryPreparation.messagesToSummarize.length - summaryPreparation.turnPrefixMessages.length,
            retainedMessages: summaryPreparation.retainedTail.length,
            tokensBefore: summaryPreparation.tokensBefore,
            keepRecentTokens: summaryPreparation.settings.keepRecentTokens,
          },
        }))
        return { decline: true }
      }
      // historyCompaction=retain 的调用配对必须保留原文：连续完整轮下不能把覆盖边界推进越过它，
      // 宁可 decline（由宿主预算守卫报告上下文不足），也不默默丢掉未覆盖历史。
      // 当前生产路径不可达：无工具声明 `retain`，由测试场景驱动（`memory-retain-guard`）。
      const retainedTool = findRetainedToolCall(summaryPreparation.messagesToSummarize, retained)
        ?? findRetainedToolCall(summaryPreparation.turnPrefixMessages, retained)
      if (retainedTool) {
        log.warn("摘要范围覆盖了必须保留原文的工具调用，本轮不压缩:", noteDecline("retained_tool", { retainedTool: { toolName: retainedTool } }))
        // 结局②（decline）：策略性不压缩，不是内核失败 —— 不写 audit.failure（会污染失败面与用户文案），
        // 原因只进 decline 记录与这条 warn。
        return { decline: true }
      }
      // ── 结局③（decline）：级 3 闸门（源方案 §3.2 要点 3 / 执行方案 §1.5）──
      // 级 1/2 是纯函数、零成本，先跑它们：压完请求视图装得下就不必花这次摘要 LLM。
      //
      // 只对 `reason === "threshold"` 生效：manual（用户显式要求压缩）与 overflow（Harness 已按
      // 硬上限实测超限）都必须照常摘要。`systemPrompt` 或 `buildGate` 缺失 ⇒ 不跑闸门、安全回退为
      // 照常摘要（缺了系统前缀/工具面的估算会偏小，保守方向宁可花一次 LLM）。
      if (reason === "threshold" && options.systemPrompt !== undefined && options.buildGate) {
        // 闸门是省钱的优化，不是正确性闸门：估算链路自身出错时照常摘要（保守方向），原因就地留痕。
        // 这里**不写 audit.failure** —— 那不是压缩内核失败，写出去会让手动路径（读同一审计槽）
        // 报 failed。拒绝原因走 noteDecline 的 decline 记录：threshold 每条检查点都可能重试，
        // 槽不为它落审计条目（只留这条日志），所以也不会产生误导性的 deskpet.compaction_declined 条目。
        try {
          const refs = await readAddressRefs(options.addressRefs, "级 3 闸门")
          const gate = ladderGate(options.buildGate(compactionGateView(summaryPreparation), refs))
          if (gate.fits) {
            log.info("级 1/2 投影后请求视图装得下，本轮不做摘要:", noteDecline("gate_fits", {
              gate: { tokens: gate.tokens, target: gate.target, level: gate.level },
            }))
            return { decline: true }
          }
          log.debug("级 1/2 之后仍超目标，照常摘要:", { tokens: gate.tokens, target: gate.target, level: gate.level })
        } catch (error) {
          log.warn("级 3 闸门估算失败，本轮照常摘要:", formatError(error))
        }
      }
      const outcome = await summarizeCompaction({
        messages: summaryPreparation.messagesToSummarize,
        turnPrefixMessages: summaryPreparation.turnPrefixMessages,
        previousSummary: summaryPreparation.previousSummary,
        model: options.model,
        signal,
        preserveToolNames: preserved,
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        ...(options.addressRefs ? { addressRefs: options.addressRefs } : {}),
        runId,
      })
      options.onSummary?.(outcome.summary)
      // 压缩摘要的派生记录：只留输入/输出 hash（摘要正文与素材不落盘），由槽在 compaction_end 写条目。
      if (options.audit) {
        options.audit.rewrite = await createPromptRewrite({
          transformId: `compaction-summary:${runId}`,
          name: "compaction_summary",
          rawText: outcome.inputText,
          derivedText: outcome.text,
          reason: "compaction",
          derivedFrom: [runId],
        })
      }
      // 结局③（成功）：恰好一条 compaction —— K 片的合并在 summarizeCompaction 内完成，
      // 到这里只剩一份 outcome，不存在「多片多次提交」的形态。
      return {
        compaction: {
          summary: outcome.text,
          retainedTail: summaryPreparation.retainedTail,
          tokensBefore: summaryPreparation.tokensBefore,
          usage: outcome.usage,
        },
      }
    } catch (error) {
      // 结局④（decline）/ X-4 的红线：**必须转 decline，绝不 rethrow**。上游对抛出的处理器只记
      // handler_error 后继续，最终走 publishStructuralReady 用上游通用英文摘要补压（见函数头注释）——
      // 那条路径不受本方案地址目录/投影阶梯约束，却会提交成唯一历史视图且不可回滚。
      // 失败原因的留痕点：审计槽（槽在 compaction_end 写 deskpet.compaction_declined 的 error 字段，
      // 以及 decline.failure 的错误码 + over_cap/oversized_unit 数字）+ log.error；本函数不制造任何静默。
      const failureText = formatError(error)
      const record = noteDecline("kernel_failure", { failure: describeCompactionFailure(error) })
      if (options.audit) options.audit.failure = failureText
      options.onFailure?.(failureText)
      log.error("摘要内核失败，本轮压缩 decline:", failureText, record)
      return { decline: true }
    }
  }
}
