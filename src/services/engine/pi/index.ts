// Pi 运行时 barrel：多轮 Agent 回合（AgentHarness lane）、一次性文本调用、Provider 网络边界的统一出口。

export {
  classifyTurnFailure,
  compactActiveSession,
  continueInterruptedRun,
  createActiveMessage,
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

export { describeInputDelivery, isInputCommitted, readContextEpoch } from "./delivery"
export type { ContextEpoch, InputCommitState, InputDeliveryEvidence, InputDeliveryLookup, InputDeliveryStage } from "./delivery"

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
  getPiRuntimeProviderOverride,
  installPiRuntimeProviderForTest,
  resetPiRuntimeProviderForTest,
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
} from "./harness-slot"

export { toAgentHarnessTools } from "@/services/tool/pi/harness-tool-adapter"
export type { HarnessToolRun } from "@/services/tool/pi/harness-tool-adapter"

export {
  MAX_PROVIDER_RESPONSE_BYTES,
  PROVIDER_TIMEOUT_MS,
  capProviderResponseBody,
  guardProviderFetch,
  configuredProviderOrigin,
  createProviderFetchGuard,
  validateProviderUrl,
} from "./net-guard"

export { createPiSessionRepo } from "./session-repo"
export type { PiSessionRepo, PiSessionRepoOptions } from "./session-repo"
