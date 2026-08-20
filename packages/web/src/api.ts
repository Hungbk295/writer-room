async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((payload as { error?: string }).error || `HTTP ${response.status}`);
  }
  return payload as T;
}

export interface Health {
  ok: boolean;
  spy: boolean;
  agents?: number;
  teamMcp?: { url: string } | null;
  uptimeMs: number;
}

export type JobNotificationKind = 'training-lab' | 'writer' | 'writer-v2';

/** Persisted only when a whole job reaches DONE — never for stage progress or failures. */
export interface JobDoneNotification {
  id: string;
  kind: JobNotificationKind;
  jobId: string;
  title: string;
  detail: string;
  createdAt: string;
  readAt: string | null;
}

export interface AgentDefinition {
  id: string;
  name: string;
  color: string;
  role: string;
  prompt: string;
  adapter: string;
  executable: string;
  args: string[];
  projectRoot: string;
  workingDirectoryMode: 'project' | 'isolated-worktree' | string;
  enabled: boolean;
  /** Pipeline lane-scheduler clone — excluded from the Agents list server-side. */
  ephemeral?: boolean;
}

export interface AgentLaunchSpec {
  agentId: string;
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  preview: string;
  warnings: string[];
  mode: string;
}

export interface TeamStatus {
  workflow: {
    stopped: boolean;
    totalTurns: number;
    queued: number;
    running: number;
    startedAt: number;
  };
  agents: Array<{ agentId: string; status: string; summary?: string; updatedAt: string }>;
  audit: Array<{ id: number; kind: string; agentId?: string | null; detail: string; createdAt: string }>;
}

export interface SpyStarted {
  operationId: string;
  spyRunId: string;
  status: string;
}

export interface SpyOperation {
  id: string;
  status: string;
  step: string;
  progress: number;
  total: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  resultRef?: string | null;
}

export interface SpyRunSummary {
  id: string;
  kind: 'video' | 'channel';
  canonicalSource: string;
  sourceIdentity: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  videoCount?: number;
  /** Channel name or the individual video title, resolved by the server. */
  displayTitle?: string;
  /** Present for standalone video runs. */
  thumbnailUrl?: string | null;
}

export interface SpyVideoRow {
  id: string;
  sourceVideoId: string;
  title: string;
  viewCount: number;
  publishedAt: string | null;
  durationSec: number;
  transcriptStatus: string;
  transcriptSource: string | null;
  frameStatus: string;
  transcriptCount: number;
  frameCount: number;
  thumbnailUrl?: string | null;
  thumbnail?: { hash: string } | null;
  canonicalUrl?: string;
  channelTitle?: string;
}

export interface TranscriptSegment {
  id: string;
  videoSnapshotId: string;
  index: number;
  startSec: number;
  endSec: number;
  text: string;
  source: string;
  language: string | null;
}

export interface TranscriptPage {
  segments: TranscriptSegment[];
  nextCursor: number | null;
  meta: {
    source: string | null;
    language: string | null;
    count: number;
    transcriptStatus: string;
    hasNormalized: boolean;
  };
}

export interface SpySettings {
  hasApiKey: boolean;
  apiKeyLast4: string | null;
  concurrency: number;
  sampling: {
    mode: string;
    frameCount: number;
    intervalSec: number;
    dhashThreshold: number;
  };
  dataRoot: string;
  spyRoot: string;
}

export interface WriterPackSummary {
  id: string;
  title: string;
  channelTitle: string;
  wordCount: number;
  videoCount: number;
  spyRunId: string;
  createdAt: string;
  warnings: string[];
}

export interface WriterPack extends WriterPackSummary {
  markdown: string;
  videoIds: string[];
}

/** Persisted shortlist behind the simple Source Pack Explorer. */
export interface SourcePackVideoPick {
  videoId: string;
  title: string;
  channelTitle: string;
  canonicalUrl: string;
  thumbnailUrl?: string | null;
  viewCount: number;
  durationSec: number;
  publishedAt: string | null;
}

export interface SourcePackSession {
  id: string;
  name: string;
  picks: SourcePackVideoPick[];
  lastWriterPackId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SourcePackSessionSummary {
  id: string;
  name: string;
  pickCount: number;
  lastWriterPackId?: string;
  updatedAt: string;
}

// ── Writer profiles / runs / taste (FM2) ─────────────────────────────────

export type TasteDecisionType =
  | 'OPENING'
  | 'ANGLE'
  | 'TRANSITION'
  | 'DEPTH'
  | 'TONE'
  | 'ENDING'
  | 'CUT';

export interface WriterProfileSummary {
  id: string;
  version: number;
  label: string;
  readiness: 'TRIAL' | 'VALIDATED';
  guidelineCount: number;
  createdAt: string;
}

export interface WriterReadyProfile {
  kind: 'WRITER_READY_PROFILE';
  id: string;
  version: number;
  label: string;
  readiness: 'TRIAL' | 'VALIDATED';
  scope: { language: string; genre?: string; contentModes: string[] };
  editorialPromise?: string;
  guidelines: Array<{
    id: string;
    instruction: string;
    when?: string;
    avoidWhen?: string;
    priority: 'CORE' | 'OPTIONAL';
    sourceRuleIds: string[];
  }>;
  antiPatterns: string[];
  createdAt: string;
}

export interface WriterRunSummary {
  id: string;
  status: 'RUNNING' | 'DONE' | 'FAILED' | 'EDITED';
  phase?: 'PLANNING' | 'RETRIEVING' | 'DRAFTING' | 'REVIEWING' | 'REFINING' | 'DONE' | 'FAILED';
  brief: string;
  requestedTitle?: string;
  targetWords?: number;
  packTitle: string;
  profileLabel: string;
  profileId: string;
  agentId: string;
  createdAt: string;
  updatedAt: string;
  hasDraft: boolean;
  editCount: number;
  decisionCount?: number;
}

// ── Write Loop v2 (STUDY → WRITE → gate → editor → repair → gate) ──────────

export interface GeneralPackSummary {
  path: string;
  version: number | null;
  title: string;
  wordCount: number;
  hash: string;
}

export interface WriterV2LedgerEntry {
  fact: string;
  videoId?: string;
  quote: string;
}

export interface WriterV2StudyArtifact {
  coverageMap: Array<{ videoId: string; mainClaim: string; angle: string }>;
  gap: string;
  outline: WriterVideoPlan;
  factsLedger: WriterV2LedgerEntry[];
}

export interface GateViolation {
  code: string;
  detail: string;
  quote?: string;
}

export interface GateResult {
  passed: boolean;
  violations: GateViolation[];
}

export interface EditorDefect {
  quote: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  note: string;
}

export type WriterV2Phase = 'STUDY' | 'WRITE' | 'GATE' | 'EDIT_REVIEW' | 'REPAIR' | 'DONE' | 'FAILED';

/** One channel-voice style file. Its `path` is the id sent back when restyling. */
export interface ChannelStyleSummary {
  path: string;
  version: number | null;
  title: string;
  wordCount: number;
  hash: string;
}

/** A style plus its full markdown — what the reader tab renders. */
export interface ChannelStyle extends ChannelStyleSummary {
  markdown: string;
}

/**
 * One restyled rendering of a finished run. Versions accumulate so the same
 * `finalScript` can be A/B'd across voices; the original is never touched.
 */
export interface StyledVersion {
  version: number;
  styleId: string;
  styleVersion: number | null;
  styleHash: string;
  agentId: string;
  path: string;
  words: number;
  createdAt: string;
}

export interface WriterRunV2 {
  id: string;
  status: 'RUNNING' | 'DONE' | 'FAILED' | 'FAILED_GATE';
  phase: WriterV2Phase;
  brief: string;
  requestedTitle?: string;
  targetWords?: number;
  audience?: string;
  packId: string;
  packTitle: string;
  generalPackPath: string;
  generalPackHash: string;
  generalPackVersion: number | null;
  formulaId: string;
  formulaVersion: number;
  formulaHash: string;
  agentId: string;
  editorAgentId: string;
  study: WriterV2StudyArtifact | null;
  draft: {
    title: string;
    script: string;
    outlineChanges: string[];
    beatAnchors: string[];
    coinedLabels?: string[];
  } | null;
  gateResults: GateResult[];
  editorDefects: EditorDefect[] | null;
  finalScript: string | null;
  repairAttempted?: boolean;
  /** Present only while a restyle stage is in flight; `status` stays DONE. */
  restyling?: { version: number; styleId: string; startedAt: string };
  restyleError?: { code: string; reason: string; at: string };
  styled?: StyledVersion[];
  createdAt: string;
  updatedAt: string;
  errorCode?: string;
  errorReason?: string;
}

export interface WriterRunV2Summary {
  id: string;
  status: WriterRunV2['status'];
  phase: WriterV2Phase;
  brief: string;
  requestedTitle?: string;
  targetWords?: number;
  packId: string;
  packTitle: string;
  generalPackPath: string;
  formulaId: string;
  formulaVersion: number;
  agentId: string;
  editorAgentId: string;
  createdAt: string;
  updatedAt: string;
  hasScript: boolean;
  gateViolationCount: number;
  defectCount: number;
  styledCount: number;
}

export interface WriterEditRecord {
  id: string;
  decisionType: TasteDecisionType;
  before: string;
  after: string;
  reason?: string;
  situation: string;
  tasteCaseId: string;
  createdAt: string;
}

export interface TastePrecedent {
  path: string;
  title: string;
  score: number;
  decisionType?: string;
  excerpt: string;
  source: 'qmd' | 'filesystem';
}

export interface WriterEditorialDecision {
  id: string;
  decisionType: string;
  situation: string;
  geometryTags: string[];
  audience?: string;
  rhetoricalNeed?: string;
  epistemicRisk?: string;
  query?: { intent: string; lex: string; vec: string; hyde: string };
  structuredQuery?: string;
  precedents: TastePrecedent[];
  retrieveWarnings: string[];
}

export interface WriterVideoPlan {
  coreInsight: string;
  memoryAnchor: {
    kind: 'name' | 'equation' | 'contrast' | 'image';
    value: string;
  };
  progression: Array<{
    beat: string;
    newInformation: string;
    characterOrArgumentChange: string;
    visualAnchor: string;
  }>;
  endingPayoff: {
    resolvesOpening: string;
    audienceCanDo: string;
  };
  cutList: string[];
}

export interface WriterQualityCheckpointDefinition {
  refId: string;
  kind: 'EDITORIAL_DECISION' | 'VIDEO_EFFECT' | 'PROFILE_GUIDELINE';
  label: string;
  instruction: string;
  weight: number;
  optional: boolean;
}

export interface WriterQualityReview {
  round: number;
  score: number;
  threshold: number;
  passed: boolean;
  hardGateViolations?: string[];
  summary?: string;
  checkpoints: Array<{
    refId: string;
    status: 'PASS' | 'PARTIAL' | 'MISS' | 'NA';
    note: string;
    evidenceQuote?: string;
  }>;
  antiPatterns: Array<{
    refId: string;
    violated: boolean;
    note: string;
    evidenceQuote?: string;
  }>;
}

export interface WriterRun {
  id: string;
  status: 'RUNNING' | 'DONE' | 'FAILED' | 'EDITED';
  phase?: 'PLANNING' | 'RETRIEVING' | 'DRAFTING' | 'REVIEWING' | 'REFINING' | 'DONE' | 'FAILED';
  brief: string;
  requestedTitle?: string;
  targetWords?: number;
  packId: string;
  packTitle: string;
  profileId: string;
  profileVersion: number;
  profileLabel: string;
  profileHash: string;
  agentId: string;
  editorialDecisions?: WriterEditorialDecision[];
  videoPlan?: WriterVideoPlan | null;
  draft: { title: string; script: string } | null;
  draftArtifactHash: string | null;
  currentScript: string | null;
  currentTitle: string | null;
  edits: WriterEditRecord[];
  tastePrecedents?: TastePrecedent[];
  tasteRagWarnings?: string[];
  qualityChecklist?: WriterQualityCheckpointDefinition[];
  qualityThreshold?: number;
  qualityReviews?: WriterQualityReview[];
  refineArtifactHash?: string | null;
  createdAt: string;
  updatedAt: string;
  errorCode?: string;
  errorReason?: string;
}

export interface TasteDecisionCase {
  id: string;
  decisionType: TasteDecisionType;
  situation: string;
  before: string;
  after: string;
  reason?: string;
  evidenceStatus: 'OBSERVED' | 'INFERRED' | 'SYNTHETIC';
  humanValidated: boolean;
  writerRunId?: string;
  createdAt: string;
}

export interface TasteCaseSummary {
  id: string;
  decisionType: TasteDecisionType;
  situation: string;
  writerRunId?: string;
  createdAt: string;
}

// ── Training (M1 Formula Discovery) — mirrors `@writer-room/training-core`'s
// `FormulaArtifact`/`AnalysisRule`/`Evidence` and daemon's `PreflightResult`/
// `RunFormulaDiscoveryResult` exactly, not divergent field names.

export interface TrainingPreflightBlocker {
  code: 'INPUT_MISSING_TRANSCRIPT' | 'INPUT_NO_CHANNEL' | 'AGENT_UNAVAILABLE';
  message: string;
}

export interface TrainingPreflightResult {
  ready: boolean;
  blockers: TrainingPreflightBlocker[];
  channelTitle: string | null;
  transcriptSegmentCount: number;
}

export interface FormulaDiscoveryDispatchResult {
  batchId: string;
  status: 'DISPATCHED' | 'BLOCKED' | 'WAITING_LANE' | 'FAILED';
  turnId?: number;
  blockers?: TrainingPreflightBlocker[];
  reason?: string;
}

export interface FormulaDiscoveryStatus {
  found: boolean;
  status?: 'RUNNING' | 'COMMITTED' | 'FAILED' | 'INTERRUPTED';
  errorCode?: string;
  artifactHash?: string;
}

/** Interactive (PTY) Formula Discovery — semi-auto path (2026-08-10), mirrors
 * `packages/daemon/src/training/orchestrator.ts`'s `StartInteractiveFormulaDiscoveryResult`. */
export interface InteractiveFormulaDiscoveryResult {
  status: 'STARTED' | 'BLOCKED' | 'FAILED';
  formulaId?: string;
  launchSpec?: AgentLaunchSpec;
  initialMessage?: string;
  blockers?: TrainingPreflightBlocker[];
  reason?: string;
}

/** Mirrors `orchestrator.ts`'s `ImportFormulaDiscoveryResult`. */
export interface ImportFormulaDiscoveryResult {
  status: 'IMPORTED' | 'NOT_DRAFT' | 'NO_OUTPUT' | 'INVALID';
  formula?: Formula;
  reason?: string;
}

export interface FormulaSummary {
  id: string;
  status: 'DRAFT' | 'TRIAL' | 'VALIDATED';
  origin: FormulaOrigin;
  version: number;
  /** Display name: rename → video title → genre/channel. */
  label: string;
  videoCount: number;
  ruleCount: number;
  createdAt: string;
  sourceBatchId?: string;
  title?: string;
  videoTitle?: string;
  channelTitle?: string;
  videoSnapshotId?: string;
}

export interface FormulaEvidence {
  segmentIds: string[];
  quote: string;
  startSec?: number;
  endSec?: number;
}

export interface FormulaRule {
  id: string;
  statement: string;
  role?: 'hook' | 'setup' | 'escalation' | 'turn' | 'payoff' | 'cta' | 'outro';
  evidence: FormulaEvidence[];
  /** COMPOUND only — where this merged rule came from. */
  sources?: RuleSource[];
  mergeOrigin?: 'CARRIED' | 'SYNTHESIZED' | 'HUMAN_EDITED';
}

export interface FormulaIncludedArtifactRef {
  videoSnapshotId: string;
  analysisArtifactHash: string;
}

/** ADR-14: one Formula type, one store, discriminated by `origin`. Mirrors
 * `@writer-room/training-core`'s `FormulaArtifact` field-for-field. */
export type FormulaOrigin = 'ANALYZED' | 'REFINED' | 'COMPOUND';

export interface RuleSource {
  videoSnapshotId: string;
  channelTitle: string;
  sourceFormulaId: string;
  sourceRuleId: string;
  evidence: FormulaEvidence[];
}

export interface FormulaLineage {
  parentFormulaId?: string;
  labRunId?: string;
  studioSessionId?: string;
}

export interface Formula {
  id: string;
  status: 'DRAFT' | 'TRIAL' | 'VALIDATED';
  origin: FormulaOrigin;
  version: number;
  rules: FormulaRule[];
  /** ANALYZED / REFINED only. */
  videoSnapshotId?: string;
  channelTitle?: string;
  /** Original video title at creation (ANALYZED/REFINED). */
  videoTitle?: string;
  /** Human display name (rename target). Defaults to video title. */
  title?: string;
  /** COMPOUND only. */
  genre?: string;
  includedArtifacts: FormulaIncludedArtifactRef[];
  lineage: FormulaLineage;
  warnings: string[];
  createdAt: string;
  sourceBatchId?: string;
}

// ── Training Lab — calibration loop (SDD §12a, M1.5) — mirrors
// `packages/daemon/src/training/training-lab.ts` and
// `@writer-room/training-core`'s `FormulaVersion`/`DraftArtifact`/`CritiqueArtifact`
// exactly, field-for-field. `FormulaVersion` is the same shape as `Formula` above
// plus `version`/`parentFormulaId` (round 1's `formulaVersionIn` is the existing
// `FormulaArtifact` wrapped, per `startTrainingLabRun`).

/** ADR-14: `version`/`lineage` live on `Formula` itself now, so a "version" IS a
 * Formula. Alias kept because the Training Lab UI names it that way. */
export type FormulaVersion = Formula;

export interface DraftArtifact {
  title: string;
  script: string;
  appliedRules: string[];
}

export interface CritiqueEvidence {
  quote: string;
  segmentIds?: string[];
  /** Required when critiquing a COMPOUND Formula (SDD §12b). */
  videoSnapshotId?: string;
}

export interface CritiquePattern {
  id: string;
  ruleId?: string;
  description: string;
  sourceEvidence: CritiqueEvidence[];
  draftEvidence: CritiqueEvidence[];
}

export interface RegressionCheckEntry {
  patternId: string;
  status: 'fixed' | 'still-present' | 'partial';
  note: string;
}

export interface CritiqueArtifact {
  positivePatterns: CritiquePattern[];
  negativePatterns: CritiquePattern[];
  regressionCheck?: RegressionCheckEntry[];
}

/** One decision REFINE made about the rule set (Write Loop v2 Phase 1.3). */
export interface TrainingLabRuleChange {
  ruleId: string;
  action: 'edit' | 'add' | 'remove' | 'narrow';
  statement: string;
  sourcePatternIds: string[];
}

/** A negative pattern REFINE attributes to execution, not to a rule. */
export interface TrainingLabNotARuleProblem {
  patternId: string;
  reason: string;
}

/** End-of-run per-rule read-out the human merges from (Write Loop v2 Phase 1.4). */
export interface TrainingLabRuleVerdict {
  ruleId: string;
  statement: string;
  exercised: number;
  hurtCount: number;
  verdict: 'KEEP' | 'SUSPECT' | 'DROP_BEFORE_MERGE';
}

export interface TrainingLabRound {
  round: number;
  formulaVersionIn: FormulaVersion;
  draft: DraftArtifact | null;
  draftArtifactHash: string | null;
  critique: CritiqueArtifact | null;
  critiqueArtifactHash: string | null;
  formulaVersionOut: FormulaVersion | null;
  changeLog: string[] | null;
  /** Write Loop v2: forced-choice REFINE output. Null on rounds refined before it. */
  ruleChanges: TrainingLabRuleChange[] | null;
  notARuleProblem: TrainingLabNotARuleProblem[] | null;
  status: 'DRAFTING' | 'CRITIQUING' | 'REFINING' | 'DONE' | 'FAILED';
  errorCode?: string;
  /** Validator detail when the stage failed (e.g. draft word count vs target). */
  errorReason?: string;
}

/** The 4 default agents (`DEFAULT_AGENT_IDS`, `packages/daemon/src/agents/defaults.ts`)
 * — kept as a plain string union here rather than importing from the daemon package,
 * same boundary the rest of `api.ts` already follows for every other server type. */
export type DefaultAgentId = 'claude' | 'codex' | 'agy' | 'grok';
export const DEFAULT_AGENT_OPTIONS: { id: DefaultAgentId; label: string }[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'agy', label: 'Antigravity' },
  { id: 'grok', label: 'Grok' },
];

export interface TrainingLabRun {
  id: string;
  videoSnapshotId: string;
  channelTitle: string;
  status: 'RUNNING' | 'DONE' | 'FAILED';
  maxRounds: number;
  rounds: TrainingLabRound[];
  createdAt: string;
  updatedAt: string;
  draftAgent: DefaultAgentId;
  critiqueAgent: DefaultAgentId;
  /** Present once the run reaches DONE. */
  ruleVerdicts?: TrainingLabRuleVerdict[];
}

export interface TrainingLabRunSummary {
  id: string;
  videoSnapshotId: string;
  channelTitle: string;
  status: 'RUNNING' | 'DONE' | 'FAILED';
  roundCount: number;
  createdAt: string;
  updatedAt: string;
  draftAgent: DefaultAgentId;
  critiqueAgent: DefaultAgentId;
}

// ── Formula Studio (SDD §12b, ADR-13) — mirrors
// `packages/daemon/src/training/studio.ts` field-for-field.

export interface RuleRef {
  formulaId: string;
  ruleId: string;
}

export interface PoolRule extends RuleRef {
  formulaVersion: number;
  formulaOrigin: FormulaOrigin;
  videoSnapshotId: string;
  channelTitle: string;
  formulaTitle: string;
  videoTitle?: string;
  statement: string;
  evidenceCount: number;
  formulaCreatedAt: string;
}

export interface PickedRule {
  videoSnapshotId: string;
  channelTitle: string;
  sourceFormulaId: string;
  sourceRuleId: string;
  statement: string;
  evidence: FormulaEvidence[];
}

export interface RuleCluster {
  id: string;
  kind: 'SIMILAR' | 'SINGLE';
  members: PickedRule[];
}

export interface RuleProposal {
  id: string;
  clusterId: string;
  /** Structured guideline text (FM1). Prefer this over legacy `statement`. */
  instruction?: string;
  /** Legacy bare-string field — older sessions / UI fallback. */
  statement?: string;
  when?: string;
  avoidWhen?: string;
  priority?: 'CORE' | 'OPTIONAL';
  sources: RuleSource[];
  decision: 'PENDING' | 'ACCEPTED' | 'REJECTED';
  edited?: boolean;
  keptOriginal?: boolean;
}

export interface StudioSession {
  id: string;
  genre: string;
  /** L1 Formulas scoped as sources — rule pool is limited to these. */
  sourceFormulaIds: string[];
  picks: RuleRef[];
  clusters: RuleCluster[];
  proposals: RuleProposal[];
  compound: Formula | null;
  /** SYNTHESIZE dispatch state (P3) — poll `getStudioSession` while `RUNNING` to see
   * `proposals` update once the turn settles; mirrors `daemon/src/training/studio.ts`. */
  synthesizeStatus: 'IDLE' | 'RUNNING' | 'FAILED';
  synthesizeAttempt: number;
  synthesizeError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StudioSessionSummary {
  id: string;
  genre: string;
  pickCount: number;
  ruleCount: number;
  status: Formula['status'] | 'EMPTY';
  updatedAt: string;
}

export const api = {
  health: () => request<Health>('/api/health'),
  listJobNotifications: () => request<{ notifications: JobDoneNotification[] }>('/api/notifications'),
  markJobNotificationRead: (id: string) =>
    request<JobDoneNotification>(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' }),

  listSpyRuns: () => request<{ runs: SpyRunSummary[] }>('/api/spy/runs'),
  getSpyRun: (id: string) => request<{
    run: SpyRunSummary;
    videos: SpyVideoRow[];
  }>(`/api/spy/runs/${id}`),
  deleteSpyRun: (id: string) =>
    request<{ ok: boolean }>(`/api/spy/runs/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  getOperation: (id: string) => request<SpyOperation>(`/api/spy/operations/${id}`),

  startChannel: (body: {
    url: string;
    depth?: string;
    topN?: number;
    selectionMode?: 'popular' | 'latest';
    scanLimit?: number;
  }) => request<SpyStarted>('/api/spy/channel', { method: 'POST', body: JSON.stringify(body) }),

  startVideo: (body: {
    url: string;
    depth?: string;
  }) => request<SpyStarted>('/api/spy/video', { method: 'POST', body: JSON.stringify(body) }),

  fetchTranscripts: (body: {
    videoIds?: string[];
    spyRunId?: string;
    topN?: number;
    force?: boolean;
  }) => request<{ operationId: string; status: string }>('/api/spy/transcripts', {
    method: 'POST',
    body: JSON.stringify(body),
  }),

  exportSourcePack: (
    spyRunId: string,
    opts: {
      limit?: number;
      videoIds?: string[];
      /** Fraction of each video transcript (default 0.5). */
      transcriptFraction?: number;
      maxCharsPerVideo?: number;
    } = {},
  ) =>
    request<{
      markdown: string;
      videoIds: string[];
      wordCount: number;
      warnings: string[];
      channelTitle: string;
    }>(`/api/spy/runs/${spyRunId}/source-pack`, {
      method: 'POST',
      body: JSON.stringify(opts),
    }),

  getTranscript: (snapshotId: string, cursor = 0, limit = 500) =>
    request<TranscriptPage>(
      `/api/spy/snapshots/${snapshotId}/transcript?cursor=${cursor}&limit=${limit}`,
    ),

  getTranscriptText: (snapshotId: string) =>
    request<{
      text: string;
      source: string;
      language: string | null;
      normalized: boolean;
      wordCount: number;
    }>(`/api/spy/snapshots/${snapshotId}/transcript/text`),

  getSettings: () => request<SpySettings>('/api/settings/spy'),
  updateSettings: (body: {
    youtubeDataApiKey?: string | null;
    concurrency?: number;
    sampling?: Partial<SpySettings['sampling']>;
  }) => request<SpySettings & { ok: boolean }>('/api/settings/spy', {
    method: 'PUT',
    body: JSON.stringify(body),
  }),

  listWriterPacks: () => request<{ packs: WriterPackSummary[] }>('/api/writer/packs'),
  getWriterPack: (id: string) => request<WriterPack>(`/api/writer/packs/${id}`),
  createWriterPack: (body: {
    title?: string;
    markdown: string;
    videoIds?: string[];
    spyRunId?: string;
    channelTitle?: string;
    wordCount?: number;
    warnings?: string[];
  }) => request<WriterPack>('/api/writer/packs', {
    method: 'POST',
    body: JSON.stringify(body),
  }),
  /** Append Spy export into an existing pack (dedupe by videoId). */
  mergeWriterPack: (
    id: string,
    body: {
      markdown: string;
      videoIds?: string[];
      spyRunId?: string;
      channelTitle?: string;
      warnings?: string[];
    },
  ) =>
    request<WriterPack>(`/api/writer/packs/${encodeURIComponent(id)}/merge`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  renameWriterPack: (id: string, title: string) =>
    request<WriterPack>(`/api/writer/packs/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),
  deleteWriterPack: (id: string) =>
    request<{ ok: boolean }>(`/api/writer/packs/${id}`, { method: 'DELETE' }),

  listSourcePackSessions: () =>
    request<{ sessions: SourcePackSessionSummary[] }>('/api/writer/source-pack-sessions'),
  getSourcePackSession: (id: string) =>
    request<SourcePackSession>(`/api/writer/source-pack-sessions/${encodeURIComponent(id)}`),
  createSourcePackSession: (name?: string) =>
    request<SourcePackSession>('/api/writer/source-pack-sessions', {
      method: 'POST',
      body: JSON.stringify(name ? { name } : {}),
    }),
  saveSourcePackSession: (id: string, body: { name?: string; picks?: SourcePackVideoPick[] }) =>
    request<SourcePackSession>(`/api/writer/source-pack-sessions/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteSourcePackSession: (id: string) =>
    request<{ ok: boolean }>(`/api/writer/source-pack-sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  searchSourcePackVideos: (query: string) =>
    request<{ videos: SourcePackVideoPick[] }>('/api/writer/source-pack-search', {
      method: 'POST',
      body: JSON.stringify({ query }),
    }),
  buildSourcePack: (sessionId: string) =>
    request<{ operationId: string; status: string }>(
      `/api/writer/source-pack-sessions/${encodeURIComponent(sessionId)}/build`,
      { method: 'POST' },
    ),

  // Writer profiles (read-only; Studio publishes) + runs + taste capture (FM2)
  listWriterProfiles: () => request<{ profiles: WriterProfileSummary[] }>('/api/writer/profiles'),
  getWriterProfile: (id: string) =>
    request<WriterReadyProfile>(`/api/writer/profiles/${encodeURIComponent(id)}`),
  /** Thin TRIAL profile so Writer works before Studio migrate finishes. */
  seedTrialProfile: (label?: string) =>
    request<WriterReadyProfile>('/api/writer/profiles/seed-trial', {
      method: 'POST',
      body: JSON.stringify({ label }),
    }),
  listWriterRuns: () => request<{ runs: WriterRunSummary[] }>('/api/writer/runs'),
  getWriterRun: (id: string) =>
    request<WriterRun>(`/api/writer/runs/${encodeURIComponent(id)}`),
  startWriterRun: (body: {
    brief: string;
    title?: string;
    targetWords?: number;
    packId: string;
    profileId: string;
    agentId?: string;
  }) =>
    request<WriterRun>('/api/writer/runs', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  deleteWriterRun: (id: string) =>
    request<{ ok: boolean }>(`/api/writer/runs/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // ── Write Loop v2 ────────────────────────────────────────────────────────
  listGeneralPacks: () => request<{ packs: GeneralPackSummary[] }>('/api/writer/general-packs'),
  getGeneralPack: (path: string) =>
    request<GeneralPackSummary & { markdown: string }>(
      `/api/writer/general-packs/${encodeURIComponent(path)}`,
    ),
  listWriterRunsV2: () => request<{ runs: WriterRunV2Summary[] }>('/api/writer/v2/runs'),
  getWriterRunV2: (id: string) =>
    request<WriterRunV2>(`/api/writer/v2/runs/${encodeURIComponent(id)}`),
  startWriterRunV2: (body: {
    brief: string;
    title?: string;
    audience?: string;
    targetWords?: number;
    packId: string;
    generalPack: string;
    formulaId: string;
    agentId?: string;
    editorAgentId?: string;
  }) =>
    request<WriterRunV2>('/api/writer/v2/runs', { method: 'POST', body: JSON.stringify(body) }),
  /** Resume only a failed WRITE after STUDY succeeded; it creates WRITE attempt 2. */
  continueWriterRunV2: (id: string) =>
    request<WriterRunV2>(`/api/writer/v2/runs/${encodeURIComponent(id)}/continue`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  listChannelStyles: () => request<{ styles: ChannelStyleSummary[] }>('/api/writer/channel-styles'),
  getChannelStyle: (path: string) =>
    request<ChannelStyle>(`/api/writer/channel-styles/${encodeURIComponent(path)}`),
  /** Rewrites a finished run in a channel voice as a new styled version; `finalScript` is untouched. */
  restyleWriterRunV2: (id: string, styleId: string) =>
    request<WriterRunV2>(`/api/writer/v2/runs/${encodeURIComponent(id)}/restyle`, {
      method: 'POST',
      body: JSON.stringify({ styleId }),
    }),
  getWriterRunV2Styled: (id: string, version: number) =>
    request<{ markdown: string }>(
      `/api/writer/v2/runs/${encodeURIComponent(id)}/styled/${encodeURIComponent(String(version))}`,
    ),
  deleteWriterRunV2: (id: string) =>
    request<{ ok: boolean }>(`/api/writer/v2/runs/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  listAgents: () =>
    request<{ agents: AgentDefinition[]; guards: Record<string, number>; defaults?: string[] }>('/api/agents'),
  saveAgent: (agent: AgentDefinition) =>
    request<{ agent: AgentDefinition }>('/api/agents', {
      method: 'PUT',
      body: JSON.stringify(agent),
    }),
  deleteAgent: (id: string) =>
    request<{ ok: boolean; deleted?: boolean }>(`/api/agents/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  detectAgent: (adapter: string, executable?: string) =>
    request<{ adapter: string; executable: string; found: boolean; version?: string; error?: string }>(
      '/api/agents/detect',
      { method: 'POST', body: JSON.stringify({ adapter, executable }) },
    ),
  seedDefaultAgents: () =>
    request<{ ok: boolean; agents: AgentDefinition[]; seeded: string[] }>('/api/agents/seed-defaults', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  launchPreview: (agentId: string) =>
    request<AgentLaunchSpec>('/api/agents/launch-preview', {
      method: 'POST',
      body: JSON.stringify({ agentId }),
    }),
  prepareLaunch: (agentId: string, cwd?: string) =>
    request<AgentLaunchSpec>('/api/agents/prepare-launch', {
      method: 'POST',
      body: JSON.stringify({ agentId, cwd }),
    }),
  launchReadiness: (agentId: string, cwd?: string) =>
    request<{ agentId: string; ready: boolean; errors: string[]; warnings: string[] }>(
      '/api/agents/readiness',
      { method: 'POST', body: JSON.stringify({ agentId, cwd }) },
    ),
  teamMcp: () => request<{ url: string; token: string }>('/api/team/mcp'),
  teamStatus: () => request<TeamStatus>('/api/team/status'),
  teamAssign: (body: {
    agentId: string;
    task: string;
    persistentInteractive?: boolean;
    orchestrated?: boolean;
  }) =>
    request<{
      assignment: { agentId: string; task: string };
      turn: { ok: boolean; turnId?: number; reason?: string };
    }>('/api/team/assign', { method: 'POST', body: JSON.stringify(body) }),

  trainingPreflight: (videoSnapshotId: string) =>
    request<TrainingPreflightResult>('/api/training/preflight', {
      method: 'POST',
      body: JSON.stringify({ videoSnapshotId }),
    }),
  startFormulaDiscovery: (videoSnapshotId: string, batchId?: string) =>
    request<FormulaDiscoveryDispatchResult>('/api/training/formula-discovery', {
      method: 'POST',
      body: JSON.stringify({ videoSnapshotId, batchId }),
    }),
  getFormulaDiscoveryStatus: (batchId: string, videoSnapshotId: string) =>
    request<FormulaDiscoveryStatus>(
      `/api/training/formula-discovery/status?batchId=${encodeURIComponent(batchId)}&videoSnapshotId=${encodeURIComponent(videoSnapshotId)}`,
    ),
  startInteractiveFormulaDiscovery: (videoSnapshotId: string, templateId: DefaultAgentId) =>
    request<InteractiveFormulaDiscoveryResult>('/api/training/formula-discovery/interactive', {
      method: 'POST',
      body: JSON.stringify({ videoSnapshotId, templateId }),
    }),
  importFormulaDiscoveryResult: (formulaId: string) =>
    request<ImportFormulaDiscoveryResult>(`/api/training/formulas/${encodeURIComponent(formulaId)}/import`, {
      method: 'POST',
    }),
  listFormulas: () => request<{ formulas: FormulaSummary[] }>('/api/training/formulas'),
  deleteFormula: (id: string) =>
    request<{ ok: boolean }>(`/api/training/formulas/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  renameFormula: (id: string, title: string) =>
    request<Formula>(`/api/training/formulas/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),

  // ── Formula Studio (SDD §12b) — all deterministic, no token spent ──
  listRulePool: (includeOlderVersions = false, formulaIds?: string[]) => {
    const params = new URLSearchParams();
    if (includeOlderVersions) params.set('includeOlderVersions', 'true');
    if (formulaIds && formulaIds.length > 0) params.set('formulaIds', formulaIds.join(','));
    const qs = params.toString();
    return request<{ rules: PoolRule[] }>(`/api/studio/rule-pool${qs ? `?${qs}` : ''}`);
  },
  listStudioSessions: () => request<{ sessions: StudioSessionSummary[] }>('/api/studio/sessions'),
  getStudioSession: (id: string) => request<StudioSession>(`/api/studio/sessions/${encodeURIComponent(id)}`),
  createStudioSession: (genre: string) =>
    request<StudioSession>('/api/studio/sessions', { method: 'POST', body: JSON.stringify({ genre }) }),
  deleteStudioSession: (id: string) =>
    request<{ ok: boolean }>(`/api/studio/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  setStudioSources: (id: string, formulaIds: string[]) =>
    request<StudioSession>(`/api/studio/sessions/${encodeURIComponent(id)}/sources`, {
      method: 'POST',
      body: JSON.stringify({ formulaIds }),
    }),
  setStudioPicks: (id: string, picks: RuleRef[]) =>
    request<StudioSession>(`/api/studio/sessions/${encodeURIComponent(id)}/picks`, {
      method: 'POST',
      body: JSON.stringify({ picks }),
    }),
  promoteStudioCompound: (id: string) =>
    request<StudioSession>(`/api/studio/sessions/${encodeURIComponent(id)}/promote`, { method: 'POST' }),
  synthesizeStudioProposals: (id: string, agentId?: DefaultAgentId) =>
    request<StudioSession>(`/api/studio/sessions/${encodeURIComponent(id)}/synthesize`, {
      method: 'POST',
      body: JSON.stringify({ agentId }),
    }),
  decideStudioProposal: (id: string, proposalId: string, decision: 'ACCEPTED' | 'REJECTED', statement?: string) =>
    request<StudioSession>(
      `/api/studio/sessions/${encodeURIComponent(id)}/proposals/${encodeURIComponent(proposalId)}/decision`,
      { method: 'POST', body: JSON.stringify({ decision, statement }) },
    ),
  getFormula: (id: string) => request<Formula>(`/api/training/formulas/${encodeURIComponent(id)}`),

  startTrainingLabRun: (
    formulaId: string,
    draftAgent: DefaultAgentId,
    critiqueAgent: DefaultAgentId,
    /** Write Loop v2: 2 by default, 1 allowed. Omit to take the server default. */
    maxRounds?: number,
  ) =>
    request<TrainingLabRun>('/api/training/lab/start', {
      method: 'POST',
      body: JSON.stringify({ formulaId, draftAgent, critiqueAgent, ...(maxRounds ? { maxRounds } : {}) }),
    }),
  listTrainingLabRuns: () => request<{ runs: TrainingLabRunSummary[] }>('/api/training/lab/runs'),
  getTrainingLabRun: (id: string) =>
    request<TrainingLabRun>(`/api/training/lab/runs/${encodeURIComponent(id)}`),
  deleteTrainingLabRun: (id: string) =>
    request<{ ok: boolean }>(`/api/training/lab/runs/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  return `${m}:${String(r).padStart(2, '0')}`;
}

export function formatTimestamp(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  const h = Math.floor(m / 60);
  if (h > 0) {
    return `${h}:${String(m % 60).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  }
  return `${m}:${String(r).padStart(2, '0')}`;
}
