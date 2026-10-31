// Pi 适配 barrel：子代理内核、回合原语、一次性文本调用、Provider 网络边界的统一出口。
// 产品编排（回合/队列/计划相位/恢复/结算/压缩）在 `@/services/engine/runtime`，这里不再转出。

// T1.5 抽出的 harness 原语。
export { runPiSubAgent } from "./subagent"
export { classifyTurnFailure, turnFailureReply } from "./turn-failure"
export { createActiveMessage, createTurnNoteMessage } from "./message-adapters"
export { defersTitlebarReleaseToReveal } from "./titlebar"

export { describeInputDelivery, isInputCommitted, readActiveAttemptEvidence, readActiveAttemptAssociations, readContextEpoch, readRequestResponse } from "./delivery"
export type { ActiveAttemptEvidence, ContextEpoch, InputCommitState, InputDeliveryEvidence, InputDeliveryLookup, InputDeliveryStage, RequestResponseEvidence } from "./delivery"

export { readLastConversationPromptTokens } from "./request-stats"

export { COMPACTION_DECLINED_ENTRY, PROMPT_REWRITE_ENTRY, PROMPT_SNAPSHOT_ENTRY } from "@/services/engine/protocol"
export type {
  CompactionAuditSink,
  PromptCapabilityContext,
  PromptCompactionContext,
  PromptPlanContext,
  PromptRequestContext,
  PromptRequestParams,
  PromptRequestPurpose,
} from "@/services/engine/protocol"

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
export type { HarnessModelsOptions, PiModel, PiRuntimeProviderOverride, PiTextCallInput, PiTextCallResult, PiTextPurpose } from "./model-gateway"
export { completePiText } from "./model-gateway"

export { createHarnessRunState } from "@/services/engine/state"
export { HarnessSlot, HARNESS_LANE, compactionSettingsFor, retryPolicyFromConfig } from "./slot"
export type { HarnessAdmitInputSpec, HarnessAdmitSkillSpec, HarnessAdmitSpec, HarnessAdmissionResult, HarnessRunSpec } from "./slot"
export { HarnessSlots, harnessSlots, isAIGenerating } from "./slot-registry"

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

export { SESSION_WRITE_MAX_BYTES } from "./session-file-system"

export { FOLD_POLICY, foldSessionFile, logStateDigest, prepareFold, readFoldLog, replayLogState } from "./session-fold"
export type { FoldLog, FoldOutcome, FoldPlan, FoldSkipReason, LogState } from "./session-fold"
