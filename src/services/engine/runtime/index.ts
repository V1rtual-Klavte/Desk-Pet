// Runtime protocol vocabulary. Keep this barrel free of business side effects.
export type {
  CompactionAuditSink,
  ContextBlock,
  ContextLayer,
  IngressEnvelope,
  InputSourceMark,
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
  serializePromptSnapshot,
  sha256Text,
  stableSerialize,
} from "./snapshot"
export type { PromptRewriteInput, PromptSnapshotInput, RedactedText } from "./snapshot"

export {
  createRuntimeTraceContext,
  publishRuntimeTrace,
  subscribeRuntimeTrace,
} from "./trace"
export type { RuntimeTraceContext, RuntimeTraceEvent, RuntimeTraceKind, RuntimeTraceListener } from "./trace"

export type { ContextAllocation } from "./types"

export {
  COMPACTION_DECLINED_ENTRY,
  DESKPET_GREETING_ENTRY,
  DESKPET_SYSTEM_MESSAGE_ENTRY,
  PROMPT_REWRITE_ENTRY,
  PROMPT_SNAPSHOT_ENTRY,
} from "./types"

export {
  INPUT_SOURCE_FIELD,
  inputEventId,
  inputSourceMark,
  inputSourceOf,
  laneMessageText,
  messageEventId,
  messageRequestId,
  userInputMessage,
} from "./input-identity"
