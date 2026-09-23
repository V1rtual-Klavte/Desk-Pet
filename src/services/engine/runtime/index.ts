// Runtime protocol vocabulary. Keep this barrel free of business side effects.
export type {
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
  PromptLlmMessage,
  PromptSnapshot,
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
  INPUT_SOURCE_FIELD,
  inputEventId,
  inputSourceMark,
  inputSourceOf,
  messageEventId,
  messageRequestId,
  userInputMessage,
} from "./input-identity"
