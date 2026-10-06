// Pi 运行时 barrel：多轮 Agent 回合（AgentHarness lane）、一次性文本调用、Provider 网络边界的统一出口。

export {
  classifyTurnFailure,
  compactActiveSession,
  continueInterruptedRun,
  createActiveMessage,
  createTurnNoteMessage,
  deliverActiveTurn,
  discardPlan,
  discardInterruptedRun,
  getInterruptedRun,
  isSessionBusy,
  listQueuedInputs,
  listRecoveredPlans,
  pausedInputsText,
  resumePlan,
  returnPausedInputs,
  runPiAgentTurn,
  runPiSubAgent,
  takePausedInputs,
  turnFailureReply,
  withdrawQueuedInput,
} from "./runtime"
export type {
  InterruptedRunInfo,
  ManualCompactionResult,
  PiAgentTurnInput,
  PiAgentTurnOutput,
  PiSubAgentInput,
  PiSubAgentOutput,
  PiSubAgentScope,
  QueuedInputsView,
  RecoveredPlanView,
  TurnFailure,
} from "./runtime"

export { describeInputDelivery, isInputCommitted, readActiveAttemptEvidence, readActiveAttemptAssociations, readContextEpoch } from "./delivery"
export type { ActiveAttemptEvidence, ContextEpoch, InputCommitState, InputDeliveryEvidence, InputDeliveryLookup, InputDeliveryStage } from "./delivery"

export { readLastConversationPromptTokens } from "./request-stats"

export { COMPACTION_DECLINED_ENTRY, PROMPT_REWRITE_ENTRY, PROMPT_SNAPSHOT_ENTRY } from "@/services/engine/runtime"
export type {
  CompactionAuditSink,
  PromptCapabilityContext,
  PromptCompactionContext,
  PromptPlanContext,
  PromptRequestContext,
  PromptRequestParams,
  PromptRequestPurpose,
} from "@/services/engine/runtime"

export { RuntimeDataStreamFilter } from "./stream-text"

export {
  createHarnessModels,
  getPiModel,
  getPiRuntimeProviderOverride,
  installPiRuntimeProviderForTest,
  resetPiRuntimeProviderForTest,
  resolvePiAuxModel,
  resolvePiTurnModel,
  toPiReasoningLevel,
} from "./model-gateway"
export type { HarnessModelsOptions, PiModel, PiRuntimeProviderOverride, PiTextCallAudit, PiTextCallInput, PiTextCallResult, PiTextPurpose } from "./model-gateway"
export { completePiText } from "./model-gateway"

export {
  HarnessSlot,
  HARNESS_LANE,
  compactionSettingsFor,
  createHarnessRunState,
  harnessSlots,
  isAIGenerating,
  retryPolicyFromConfig,
} from "./harness-slot"
export type {
  HarnessAbortReason,
  HarnessCancelQueuedKind,
  HarnessCompactOutcome,
  HarnessDeliveryPhase,
  HarnessDeliveryReceipt,
  HarnessQueueCounts,
  HarnessQueuedItem,
  HarnessRunHooks,
  HarnessRunResult,
  HarnessRunSinks,
  HarnessRunSpec,
  HarnessRunState,
  HarnessRunStatus,
  HarnessSlotSnapshot,
  HarnessSlotState,
  HarnessStructuralHost,
  HarnessTurnAdmission,
} from "./harness-slot"

export { toAgentHarnessTools } from "@/services/tool"
export type { HarnessToolRun } from "@/services/tool"

export {
  MAX_PROVIDER_RESPONSE_BASE_BYTES,
  PROVIDER_RESPONSE_BYTES_PER_TOKEN,
  providerResponseByteCap,
  PROVIDER_TIMEOUT_MS,
  capProviderResponseBody,
  guardProviderFetch,
  configuredProviderOrigin,
  createProviderFetchGuard,
  validateProviderUrl,
} from "./net-guard"

export { createPiSessionRepo } from "./session-repo"
export type { PiSessionRepo, PiSessionRepoOptions } from "./session-repo"

export { FRAME_BUFFER_MAX_BYTES, FRAME_FLUSH_FAILURE_MARK, FrameBufferingFileSystem, flushSessionFrameWrites } from "./session-frame-buffer"

export { FOLD_POLICY, foldSessionFile, logStateDigest, prepareFold, readFoldLog, replayLogState } from "./session-fold"
export type { FoldLog, FoldOutcome, FoldPlan, FoldSkipReason, LogState } from "./session-fold"
