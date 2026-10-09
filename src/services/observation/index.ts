export { startSilentUnderstanding, stopSilentUnderstanding } from "./scheduler"
export type { ScreenCaptureResult } from "./scheduler"
// 领域侧协议：本地应用与（原生 UI 万一需要的）路由注入点（原生宿主迁移过程记录 §9.4 第 7 条）。
export {
  applyObservationGovernance,
  clearSilentUnderstanding,
  invalidateTopicSources,
  setObservationGovernanceRouter,
} from "./ownership"
export type { ObservationGovernanceOperation, ObservationGovernanceRouter } from "./ownership"
export { completeUnverifiedMemoryClosure, getUnderstandingPromptBlock, getUnderstandingPromptBlockAsync, getUnderstandingSnapshot, getUnderstandingSnapshotAsync, getTopicWeights, getUnverifiedUnderstandingSourceIds, hasUnverifiedMemoryClosurePending, hasUnverifiedUnderstandingEvidence } from "./store"
export type { CommittedUserParticipation, UnderstandingRecord, UnderstandingSnapshot, TopicWeight, TopicEvidence, TopicCategory, TopicStance, TopicSensitivity, ReadTargetRequest, TargetReadResult } from "./types"
export { drainTopicIntake, recordCommittedUserParticipation } from "./topics"
