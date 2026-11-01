// Runtime protocol vocabulary. Keep this barrel free of business side effects.
export type {
  CompactionAuditSink,
  CompactionDeclineKind,
  CompactionDeclineRecord,
  CompactionOverflowDetail,
  CompactionTrigger,
  ContextBlock,
  ContextLayer,
  IngressEnvelope,
  InputSourceMark,
  MessageOrigin,
  MessagePriority,
  MessageTaint,
  PlanEffectClass,
  PlanCompletion,
  PlanRecord,
  PlanState,
  PlanStepAcceptanceCheck,
  PlanStepOutcome,
  PlanStepOutcomeStatus,
  PlanStepRecord,
  PlanStepState,
  PlanVerification,
  PlanVerificationVerdict,
  PromptAgentMessage,
  PromptCacheInfo,
  PromptCapabilityContext,
  PromptCompactionContext,
  PromptLlmMessage,
  PromptPlanContext,
  PromptRequestContext,
  PromptRequestParams,
  PromptRequestPurpose,
  PromptSnapshot,
  PromptTokenDrift,
  PromptToolSchema,
  PromptTransform,
  PromptTransformReason,
  QuerySource,
} from "./types"

export {
  createPromptRewrite,
  createPromptSnapshot,
  redactText,
  refreshMessageAllocations,
  serializePromptSnapshot,
  sha256Text,
  stableSerialize,
} from "./snapshot"
export type { PromptRewriteInput, PromptSnapshotInput, RedactedText } from "./snapshot"

export {
  createRuntimeTraceContext,
  hasRuntimeTraceSubscribers,
  publishMemoryRecallReferences,
  publishRuntimeTrace,
  runtimeTraceContextForRequest,
  runtimeTracePreview,
  subscribeRuntimeTrace,
} from "./trace"
export type { RuntimeTraceContext, RuntimeTraceEvent, RuntimeTraceKind, RuntimeTraceListener } from "./trace"

export type { ContextAllocation } from "./types"

export {
  COMPACTION_DECLINED_ENTRY,
  DESKPET_GREETING_ENTRY,
  DESKPET_SYSTEM_MESSAGE_ENTRY,
  MEMORY_CITATIONS_ENTRY,
  PROMPT_REWRITE_ENTRY,
  PROMPT_SNAPSHOT_ENTRY,
  RECALL_FAILED_ENTRY,
} from "./types"
export type { MemoryCitationConversationRef, MemoryCitationEntryData } from "./types"

export {
  INPUT_SOURCE_FIELD,
  inputEventId,
  inputSourceMark,
  inputSourceOf,
  isTransientInputMessage,
  laneMessageText,
  messageEventId,
  messageRequestId,
  TURN_NOTE_CUSTOM_TYPE,
  MEMORY_RECALL_CUSTOM_TYPE,
  isMemoryRecallMessage,
  createMemoryRecallMessage,
  userInputMessage,
} from "./input-identity"

export {
  PLAN_CHECKPOINT_ENTRY, PLAN_RECOVERY_FAILED_ENTRY, PLAN_STEP_RESULT_ENTRY, PLAN_WRITE_FAILED_ENTRY,
} from "./entries"
export { formatPlanStepResultReadback, planAcceptanceLabel, planOutcomeLabel, planVerificationLabel } from "./plan-readback"
