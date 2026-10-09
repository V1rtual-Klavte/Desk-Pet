// ==========================================
// 核心引擎 —— 统一导出
// ==========================================

// ── PreProcessor ──
export { preProcess } from "./preprocessor"
export type { PreProcessDedupAdmission, PreProcessResult, PreProcessState } from "./preprocessor"

// ── Context ──
// 构建入口 `buildPrompt` 由 `@/services/context` 直接导出：引擎 barrel 不再转出一份。
export type { BuildContextInput, BuildContextOutput } from "@/services/context"

// ── Slash ──
// 命令查找/执行只在 ingress（preProcess → slash/registry）内部发生：
// UI 侧只需要下拉补全数据，不再导出第二条执行入口。
export { initSlashCommands, search as searchSlashCommands, listAll as listAllSlashCommands } from "./slash"
export type { SlashCommand, SlashMatch } from "./slash"

// ── Compactor ──
// 摘要内核经 before_compaction 钩子使用；旧调度入口（compactSession）随 H-4 退役。
// `measureCompactionMaterial` 是摘要素材的**唯一度量出口**：场景断言与分片规划读它的产物，
// 不得对同一份素材另拼 JSON 重算 token。
// `CompactionOverflowError` 是「素材超上限」的唯一失败类型（`code` + `detail.reason` 可判定）：
// 场景用它做 `instanceof` 断言，与其它预算失败（ContextBudgetError）区分开。
export { summarizeCompaction, planCompactionShards, measureCompactionMaterial, CompactionOverflowError, describeCompactionFailure, COMPACTION_SLICE_RATIO, MAX_COMPACTION_SLICES } from "./compactor"
export type { CompactionSummaryInput, CompactionSummaryOutcome, CompactionShardPlan, CompactionMaterial } from "./compactor"

// ── Planner ──
export {
  evaluateComplexity, generatePlan, executePlan, formatStepResults,
  normalizePlan, planToRecords, recordsToPlan, planEffectClassFor,
} from "./planner"
export type {
  PlanStep, PlanResult, ComplexityResult, PlanExecutionResult,
  GeneratePlanContext, PlanRecordContext,
} from "./planner"

// ── Plan 确认桥接（会话键控）──
// requestPlanConfirm/requestPlanStepDecision 只由 runtime 与同域的计划提案模块
// （`plan/proposal.ts`）调用，不经 barrel；面板与测试替身按 planId 应答，
// 并读 planConfirmState 的只读视图。
export {
  abortRunningPlan, bindRunningPlan, cancelSessionPlans, clearRunningPlan,
  notifyPlanEnd, planConfirmState, resolvePlanConfirm, resolvePlanStepDecision,
  disposePlanConfirmationReceipts, planConfirmDeclineText,
} from "./plan-confirmation"
// Plan checkpoint 单例：面板的「未知副作用步骤处置」（标记已完成 / 重跑此步）经
// `resolveUnknownSideEffect` 走它 —— 与 runtime 的落盘/恢复同一条记录路径
// （不另开第二份计划记录读写口）。
export { planCheckpointStore } from "./plan/checkpoint-store"

// ── 提问选择（ask_user 的确认通道）──
// 与 plan-confirmation 同一分区方式：requestChoice 是工具域经 barrel 动态导入的唯一
// 提问入口；面板与测试替身按 requestId 应答，并读 choiceState 的只读视图。
export {
  cancelSessionChoices, choiceDeclineText, choiceState, disposeChoiceConfirmationReceipts,
  notifyChoiceEnd, requestChoice, resolveChoice,
} from "./choice-confirmation"
export type { ChoiceOutcome, ChoiceResolution } from "./choice-confirmation"

// ── 模型提议计划（propose_plan 工具的执行相位）──
// 与自动入口（runtime 的 runPlanPhase）共用确认通道、执行器与记录存储；唯一消费者
// 是 `tool/local-extra/plan.ts`，产物归宿是工具结果而不是主回合上下文。
export { runProposedPlan } from "./plan/proposal"
export type { ProposedPlanInput, ProposedPlanOutcome } from "./plan/proposal"

// ── Runtime protocol vocabulary ──
export type {
  ContextBlock,
  ContextLayer,
  IngressEnvelope,
  MessageOrigin,
  MessagePriority,
  MessageTaint,
  PlanEffectClass,
  PlanRecord,
  PlanState,
  PlanStepRecord,
  PlanStepState,
  PromptAgentMessage,
  PromptCacheInfo,
  PromptLlmMessage,
  PromptSnapshot,
  PromptToolSchema,
  PromptTransform,
  PromptTransformReason,
  QuerySource,
} from "./runtime"
export {
  createPromptSnapshot,
  redactText,
  serializePromptSnapshot,
  sha256Text,
  stableSerialize,
} from "./runtime"
export type { PromptSnapshotInput, RedactedText } from "./runtime"
export {
  createRuntimeTraceContext,
  hasRuntimeTraceSubscribers,
  publishRuntimeTrace,
  runtimeTraceContextForRequest,
  runtimeTracePreview,
  subscribeRuntimeTrace,
} from "./runtime"
export type { RuntimeTraceContext, RuntimeTraceEvent, RuntimeTraceKind, RuntimeTraceListener } from "./runtime"

// ── Pi Agent Core Runtime ──
export {
  compactActiveSession,
  continueInterruptedRun,
  deliverActiveTurn,
  describeInputDelivery,
  discardPlan,
  discardInterruptedRun,
  getInterruptedRun,
  harnessSlots,
  isSessionBusy,
  listQueuedInputs,
  listRecoveredPlans,
  resumePlan,
  runPiAgentTurn,
  takePausedInputs,
  withdrawQueuedInput,
} from "./harness"
export type {
  HarnessQueuedItem,
  InputDeliveryEvidence,
  InputDeliveryStage,
  InterruptedRunInfo,
  ManualCompactionResult,
  PiAgentTurnOutput,
  QueuedInputsView,
  RecoveredPlanView,
} from "./harness"
