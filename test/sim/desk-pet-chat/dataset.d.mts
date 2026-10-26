export type DatasetPurpose = "development" | "calibration" | "holdout" | "regression";
export type CaseSourceKind = "ideal" | "confirmed-issue" | "requirement";
export type HostCapability = "chat" | "memory" | "session";
export type TimeMode = "real" | "fixed";
export type MemoryKind = "fact" | "preference" | "episode" | "working";
export type MemoryScope = "user" | "card" | "session";
export type FixturePreparation = "seed_session" | "seed_memory" | "seed_card" | "seed_profile";
export type FixtureLoadingMode = "direct-seed" | "real-chain";
export type ProbeDifficulty = 1 | 2 | 3 | 4 | 5;
export type DriverHostMethod =
  | "chat_new_session"
  | "chat_switch_session"
  | "chat_stop"
  | "chat_slash_command"
  | "memory_dreaming_sweep";
export type CheckpointWait = "assistant_message" | "memory_extraction_end" | "session_created" | "host_readback";
export type EvidenceKind = "session_entry" | "memory_before_after" | "trace_event" | "host_readback" | "artifact";
export type QualityRubric = "humanizer-six-dimensions";
export type ReviewRole = "user";
export type FeedbackSourceKind = "session_message";
export type ReviewDecision = "approved" | "rejected";
export type OracleCheckKind = "result" | "path" | "source" | "temporal" | "delivery" | "semantic";
export type ProbeWindow = "last-assistant" | "state" | "all-assistant";
export type ProbePolarity = "required" | "forbidden";
export type ProbeFrequency = "once-weekly" | "frequent" | "thrice-weekly" | "frequent-or-thrice-weekly";
export type ProbeTemporal = "current" | "past";
export type ProbeExpectationKind =
  | "none"
  | "fact"
  | "cross-session"
  | "temporal-scope"
  | "subjects"
  | "session-source";
export type CaseTier = "gold" | "silver";
export type CaseLabelStatus = "approved" | "rejected" | "stale" | "pending";

export interface QuestionTypeFamily {
  readonly id: string;
  readonly name: string;
  readonly goal: string;
}

export interface QuestionTypeSpec {
  readonly id: string;
  readonly family: string;
  readonly name: string;
  readonly goal: string;
  readonly capabilities: readonly string[];
}

export interface QuestionTypeRegistryInput {
  schemaVersion: 1;
  families: QuestionTypeFamily[];
  questionTypes: QuestionTypeSpec[];
}

export interface RubricSpec {
  readonly id: string;
  readonly kind: OracleCheckKind;
  readonly expectation: ProbeExpectationKind;
  readonly description: string;
}

export const DATASET_SCHEMA_VERSION: 4;
export const QUESTION_TYPES_SCHEMA_VERSION: 1;
export const DEFAULT_DATASET_ROOT: string;
export const DEFAULT_CATEGORIES_PATH: string;
export const DEFAULT_QUESTION_TYPES_PATH: string;
export const PURPOSE_VALUES: readonly DatasetPurpose[];
export const SOURCE_KIND_VALUES: readonly CaseSourceKind[];
export const HOST_CAPABILITY_VALUES: readonly HostCapability[];
export const TIME_MODE_VALUES: readonly TimeMode[];
export const MEMORY_KIND_VALUES: readonly MemoryKind[];
export const MEMORY_SCOPE_VALUES: readonly MemoryScope[];
export const FIXTURE_PREPARATION_VALUES: readonly FixturePreparation[];
export const FIXTURE_LOADING_MODE_VALUES: readonly FixtureLoadingMode[];
export const PROBE_DIFFICULTY_LEVELS: readonly ProbeDifficulty[];
export const DRIVER_HOST_METHOD_VALUES: readonly DriverHostMethod[];
export const CHECKPOINT_WAIT_VALUES: readonly CheckpointWait[];
export const EVIDENCE_KIND_VALUES: readonly EvidenceKind[];
export const QUALITY_RUBRIC_VALUES: readonly QualityRubric[];
export const REVIEW_ROLE_VALUES: readonly ReviewRole[];
export const FEEDBACK_SOURCE_VALUES: readonly FeedbackSourceKind[];
export const DECISION_VALUES: readonly ReviewDecision[];
export const ORACLE_CHECK_KIND_VALUES: readonly OracleCheckKind[];
export const PROBE_WINDOW_VALUES: readonly ProbeWindow[];
export const PROBE_POLARITY_VALUES: readonly ProbePolarity[];
export const PROBE_FREQUENCY_VALUES: readonly ProbeFrequency[];
export const PROBE_TEMPORAL_VALUES: readonly ProbeTemporal[];
export const PROBE_EXPECTATION_KIND_VALUES: readonly ProbeExpectationKind[];
export const RUBRIC_SPECS: readonly RubricSpec[];

export interface SubjectSpec {
  label: string;
  aliases: string[];
}

export interface FrequencyFactSpec {
  kind: "frequency";
  subject: SubjectSpec;
  frequency: ProbeFrequency;
  temporal: ProbeTemporal;
}

export interface ChoiceFactSpec {
  kind: "choice";
  value: string;
  aliases: string[];
}

export type FactSpec = FrequencyFactSpec | ChoiceFactSpec;

export interface FactRecallExpectation {
  fact: FactSpec;
}

export interface CrossSessionExpectation {
  sourceStep: string;
  requiredFacts: FactSpec[];
  anyOfFacts?: FactSpec[];
}

export interface TemporalScopeExpectation {
  forbidden: Array<{
    subject: SubjectSpec;
    frequency: ProbeFrequency;
    temporal: ProbeTemporal;
  }>;
}

export interface MemorySubjectsExpectation {
  subjects: SubjectSpec[];
}

export interface SessionSourceExpectation {
  sourceStep: string;
}

export type ProbeExpectation =
  | FactRecallExpectation
  | CrossSessionExpectation
  | TemporalScopeExpectation
  | MemorySubjectsExpectation
  | SessionSourceExpectation;

export class DatasetError extends Error {
  code: string;
  constructor(code: string, message: string);
}

export interface CaseSource {
  kind: CaseSourceKind;
  ref: string;
  excerpt: string;
  note?: string;
}

export interface CasePrecondition {
  card: string;
  profile: string;
  fixtureId: string;
  time: { mode: TimeMode };
  hostCapabilities: HostCapability[];
}

export interface UserRoleSpec {
  knownFacts: string[];
  goal: string;
  tone: string;
  allowedActions: string[];
  mustNotReveal: string[];
}

export interface MessageDriverStep {
  id: string;
  kind: "message";
  text: string;
  at?: string;
}

export interface HostDriverStep {
  id: string;
  kind: "host";
  method: DriverHostMethod;
  args?: Record<string, unknown>;
  note?: string;
  at?: string;
}

export type DriverStep = MessageDriverStep | HostDriverStep;

export interface CheckpointSpec {
  id: string;
  after: string;
  wait: CheckpointWait;
  note?: string;
}

export interface ProbeSpec {
  id: string;
  after: string;
  window: ProbeWindow;
  rubric: string;
  questionType: string;
  polarity: ProbePolarity;
  critical: boolean;
  difficulty: ProbeDifficulty;
  description: string;
  evidence?: string[];
  expectation?: ProbeExpectation;
}

export interface OracleSpec {
  allowedAlternatives: string[];
}

export interface PathConstraints {
  requiredOrder: string[];
  forbiddenSideEffects: string[];
  allowedToolSubstitutions: string[];
}

export interface EvidenceSpec {
  id: string;
  kind: EvidenceKind;
  source: string;
  description: string;
}

export interface QualitySpec {
  rubric: QualityRubric;
  rubricVersion: number;
}

export interface GovernanceSpec {
  purpose: DatasetPurpose;
  unresolvedPoints: string[];
  notes: string[];
}

export interface CaseSpec {
  schemaVersion: 4;
  caseId: string;
  revision: number;
  familyId: string;
  title: string;
  categories: string[];
  questionTypes: string[];
  source: CaseSource;
  precondition: CasePrecondition;
  userRole: UserRoleSpec;
  driver: DriverStep[];
  probes: ProbeSpec[];
  checkpoints: CheckpointSpec[];
  oracle: OracleSpec;
  pathConstraints: PathConstraints;
  evidence: EvidenceSpec[];
  quality: QualitySpec;
  governance: GovernanceSpec;
}

export interface FixtureMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  at: string;
}

export interface FixtureSession {
  id: string;
  title: string;
  messages: FixtureMessage[];
}

export interface FixtureMemorySource {
  sessionId: string;
  messageId: string;
}

export interface FixtureMemory {
  id: string;
  kind: MemoryKind;
  scope: MemoryScope;
  origin: "user";
  content: string;
  source: FixtureMemorySource;
  validFrom: string;
  validUntil: string | null;
}

export interface FixtureLoading {
  mode: FixtureLoadingMode;
  note: string;
}

export interface FixtureSpec {
  schemaVersion: 4;
  fixtureId: string;
  card: string;
  profile: string;
  clock: string;
  loading: FixtureLoading;
  initialSession: FixtureSession;
  initialMemory: FixtureMemory[];
  allowedPreparation: FixturePreparation[];
}

export interface CaseBinding {
  contentHash: string;
  fixtureHash: string;
  driverHash: string;
  oracleHash: string;
  specHash: string;
}

export interface BindingMismatch {
  field: keyof CaseBinding;
  approved: string;
  current: string;
}

export interface CaseLabel {
  tier: CaseTier;
  status: CaseLabelStatus;
  approvalId: string | null;
  reviewedAt: string | null;
  mismatches: BindingMismatch[];
}

export interface ReviewReviewer {
  role: ReviewRole;
  name: string;
}

export interface ReviewFeedbackSource {
  kind: FeedbackSourceKind;
  sessionId: string;
  messageId: string;
  quote: string;
}

export interface ApprovalRecord {
  schemaVersion: 4;
  approvalId: string;
  caseId: string;
  suiteId: string;
  revision: number;
  decision: ReviewDecision;
  reviewer: ReviewReviewer;
  reviewedAt: string;
  feedbackSource: ReviewFeedbackSource;
  binding: CaseBinding;
  notes: string;
  supersedes?: string;
}

export interface LoadedApproval extends ApprovalRecord {
  path: string;
}

export interface CaseEntry {
  caseId: string;
  suiteId: string;
  casePath: string;
  fixturePath: string;
  case: CaseSpec;
  fixture: FixtureSpec;
  binding: CaseBinding;
  approvals: ApprovalRecord[];
  label: CaseLabel;
}

export interface DatasetIssue {
  code: string;
  message: string;
  file?: string;
  suiteId?: string;
  caseId?: string;
}

export interface SuiteSpec {
  schemaVersion: 4;
  suiteId: string;
  revision: number;
  purpose: DatasetPurpose;
  title: string;
  caseIds: string[];
}

export interface SuiteRecord extends SuiteSpec {
  path: string;
}

export interface CategoryInput {
  id: string;
  [key: string]: unknown;
}

export interface Dataset {
  schemaVersion: 4;
  repoRoot: string;
  root: string;
  categoriesPath: string | null;
  categories: CategoryInput[];
  questionTypesPath: string | null;
  questionTypeFamilies: QuestionTypeFamily[];
  questionTypes: QuestionTypeSpec[];
  suites: SuiteRecord[];
  cases: CaseEntry[];
  approvals: LoadedApproval[];
  errors: DatasetIssue[];
  warnings: DatasetIssue[];
}

export interface LoadDatasetOptions {
  root?: string;
  repoRoot?: string;
  categoriesPath?: string;
  categories?: ReadonlyArray<string | CategoryInput>;
  questionTypesPath?: string;
  questionTypes?: QuestionTypeRegistryInput;
}

export interface DriverPackage {
  schemaVersion: 4;
  caseId: string;
  revision: number;
  specHash: string;
  userRole: UserRoleSpec;
  driver: DriverStep[];
}

export interface ReviewApprovalSummary {
  approvalId: string;
  decision: ReviewDecision;
  reviewedAt: string;
  reviewer: ReviewReviewer;
  feedbackSource: ReviewFeedbackSource;
  notes: string;
  supersedes: string | null;
  matching: boolean;
  mismatches: BindingMismatch[];
}

export interface ReviewPackage {
  schemaVersion: 4;
  suiteId: string;
  caseId: string;
  revision: number;
  title: string;
  purpose: DatasetPurpose;
  label: CaseLabel;
  binding: CaseBinding;
  questionTypes: string[];
  difficultyCounts: Record<`${ProbeDifficulty}`, number>;
  trustBoundary: {
    driverPackageFields: string[];
    excludedFromDriver: string[];
    probeWindowScope: "driver-only";
    note: string;
  };
  candidate: CaseSpec;
  fixture: {
    fixtureId: string;
    hash: string;
    loading: FixtureLoading;
    content: FixtureSpec;
  };
  approvalHistory: ReviewApprovalSummary[];
  unresolvedPoints: string[];
}

export interface ReviewDecisionInput {
  caseId: string;
  decision: ReviewDecision;
  notes?: string;
}

export interface ApplyReviewDecisionsInput {
  entries: readonly CaseEntry[];
  decisions: readonly ReviewDecisionInput[];
  reviewer: ReviewReviewer;
  feedbackSource: ReviewFeedbackSource;
  reviewedAt: string;
}

export interface ApplyReviewDecisionsResult {
  records: ApprovalRecord[];
  errors: DatasetIssue[];
}

export interface DatasetSummary {
  suiteCount: number;
  caseCount: number;
  goldCount: number;
  silverCount: number;
  probeCount: number;
  criticalProbeCount: number;
  statusCounts: Record<CaseLabelStatus, number>;
  categoryCounts: Record<string, number>;
  questionTypeCounts: Record<string, number>;
  caseQuestionTypeCounts: Record<string, number>;
  difficultyCounts: Record<`${ProbeDifficulty}`, number>;
  suites: Array<{
    suiteId: string;
    purpose: DatasetPurpose;
    caseCount: number;
    goldCount: number;
    silverCount: number;
    probeCount: number;
    criticalProbeCount: number;
  }>;
}

export function stableStringify(value: unknown): string;
export function hashCanonical(value: unknown): string;
export function computeCaseBinding(caseSpec: CaseSpec, fixture: FixtureSpec): CaseBinding;
export function datasetInputHash(dataset: Dataset, entry: Pick<CaseEntry, "suiteId" | "case" | "fixture">): string;
export function resolveCaseLabel(binding: CaseBinding, approvals: readonly ApprovalRecord[]): CaseLabel;
export function validateCaseSpec(
  spec: unknown,
  options?: { categoryIds?: Iterable<string>; questionTypeIds?: Iterable<string> },
): CaseSpec;
export function validateFixtureSpec(spec: unknown, options?: { expectedFixtureId?: string }): FixtureSpec;
export function validateCaseAgainstFixture(caseSpec: CaseSpec, fixture: FixtureSpec): void;
export function validateApprovalRecord(
  spec: unknown,
  options?: { expectedApprovalId?: string; expectedCaseId?: string; expectedSuiteId?: string },
): ApprovalRecord;
export function applyReviewDecisions(input: ApplyReviewDecisionsInput): ApplyReviewDecisionsResult;
export function buildDriverPackage(entry: CaseEntry): DriverPackage;
export function buildReviewPackage(entry: CaseEntry, approvals?: readonly ApprovalRecord[]): ReviewPackage;
export function formatReviewPackage(review: ReviewPackage): string;
export function formatExpectation(expectation: ProbeExpectation | null | undefined): string;
export function summarizeDataset(dataset: Dataset): DatasetSummary;
export function loadDataset(options?: LoadDatasetOptions): Dataset;
