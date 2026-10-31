// 手动压缩一个会话的编排入口。
// 纯搬移自 harness/runtime.ts（T1.6 拆入 runtime 编排层），不改变行为。

import { createRuntimeTraceContext } from "@/services/engine/protocol"
import type { CompactionAuditSink } from "@/services/engine/protocol"
import { getV1rtualInstructionsSync } from "@/services/context/instructions"
import { buildPrompt } from "@/services/context"
import { getPoolSnapshot } from "@/services/personality/variable-pool"
import { getActiveCard } from "@/services/personality/registry"
import { listAll } from "@/services/tool"
import type { ToolDef } from "@/services/tool"
import { aiConfig } from "@/services/config"
import { resolvePiTurnModel } from "@/services/engine/harness/model-gateway"
import { createHarnessRunState } from "@/services/engine/state"
import type { HarnessCompactOutcome } from "@/services/engine/state"
import { harnessSlots } from "@/services/engine/harness/slot-registry"
import { createCompactionHook, createLadderGateBuilder } from "@/services/engine/harness/compaction-hook"
import { createRequestOptionsPatch, createRequestViewHook, createRuntimeDataStripHook } from "@/services/engine/harness/request-view"

// ── 手动压缩入口（/compact） ──

export type ManualCompactionResult = HarnessCompactOutcome & { intent?: string }

/**
 * 手动压缩一个会话：切点、提交与持久化由 Harness 承担（manual reason），
 * 摘要走结构化摘要内核。运行中返回 busy，有排队项返回 pending（准入读 lane 真相），
 * 两种情况都由命令层给出用户可见文案（§3.4）。
 *
 * 压缩后 Harness 可能驱动一次续跑消费 lane inbox：那段续跑没有回合身份，但仍要有人格
 * 前缀、投影与 RUNTIME_DATA 剥离，所以这里按当前冻结上下文构造 systemPrompt 并下发
 * 结构操作宿主面（空工具集：没有回合并发上限的续跑不接工具，见决策 §7 #29 A）。
 */
export async function compactActiveSession(sessionId: string): Promise<ManualCompactionResult> {
  if (!sessionId.trim()) return { status: "failed", error: "当前没有可压缩的会话" }
  const model = resolvePiTurnModel()
  const requestId = `compact-${crypto.randomUUID()}`
  const traceContext = createRuntimeTraceContext(sessionId, requestId)
  let intent: string | undefined
  const slot = harnessSlots.ensure(sessionId)
  // 与 continueInterruptedRun 同形：没有回合上下文时用当前 Card/变量重建只读前缀，
  // 不静默改 Card。tools 传空集：结构操作不向模型宣告它不能用的工具。
  const currentCard = getActiveCard()
  const card = currentCard ? JSON.parse(JSON.stringify(currentCard)) as typeof currentCard : null
  const pool = getPoolSnapshot()
  const context = buildPrompt({
    ...{ v1rtualInstructions: getV1rtualInstructionsSync() },
    unansweredCount: 0, thinkingEffort: aiConfig.thinkingEffort,
    contextMaxTokens: model.contextWindow, maxOutputTokens: model.maxTokens,
    tools: [],
  }, card, pool)
  const state = createHarnessRunState()
  // 压缩审计槽：宿主内核失败时给出可见原因（/compact 报 failed），并让槽写降级条目。
  const compactionAudit: CompactionAuditSink = {}
  // 结构操作的工具面是空的：投影与级 3 闸门共用同一份 —— 闸门估的就是续跑投影会做的那件事。
  const structureTools: readonly ToolDef[] = []
  const structurePreserveToolNames: ReadonlySet<string> = new Set<string>()
  const outcome = await slot.compact({
    systemPrompt: context.systemPrompt,
    state,
    traceContext,
    traceBridgeState: { linkedNativeRunIds: new Set(), firstTextGenerated: false },
    hooks: {
      // 手动压缩没有冻结的回合工具集，按当前注册表判定 retain 保护。
      beforeCompaction: createCompactionHook({
        model, tools: listAll(),
        sessionId, onSummary: summary => { intent = summary.intent }, audit: compactionAudit,
        // reason === "manual" 不跑闸门（用户显式要求压缩）；续跑期间的阈值压缩照跑 ——
        // 系统前缀取结构操作下发的这一份，与 `slot.compact` 的 systemPrompt 同源。
        systemPrompt: context.systemPrompt,
        buildGate: createLadderGateBuilder({
          systemPrompt: context.systemPrompt, model,
          tools: structureTools, preserveToolNames: structurePreserveToolNames,
        }),
        // 摘要素材与随后的续跑投影共用同一份地址目录 thunk（与主回合同一通道）。
        addressRefs: () => slot.addressRefs(),
      }),
      compactionAudit,
      beforeRequest: createRequestOptionsPatch(),
      // 续跑也走宿主的投影与剥离；工具结果投影按空工具集（安全回退，不开工具）——
      // 没有工具声明就没有 preserve 名单，历史结果照常进候选集走阶梯（与投影 hook 对未注册
      // 工具的口径一致）。
      transformContext: createRequestViewHook({
        projectToolResults: true,
        toolsByName: new Map(),
        preserveToolNames: structurePreserveToolNames,
        model,
        supportsImages: model.input.includes("image"),
        state,
        // 结构操作没有回合身份：不落 PromptSnapshot，也没有 payload 观测的读者。
        captureSnapshot: async () => undefined,
        snapshotTasks: [],
        latestMessages: () => { },
        addressRefs: () => slot.addressRefs(),
      }),
      afterResponse: createRuntimeDataStripHook({}),
    },
  })
  // 宿主内核失败 → 明确失败并带上原因（用户看到「未压缩：<原因>」），不报「压缩完成」。
  if (outcome.status === "declined" && compactionAudit.failure) return { status: "failed", error: compactionAudit.failure }
  return intent === undefined ? outcome : { ...outcome, intent }
}
