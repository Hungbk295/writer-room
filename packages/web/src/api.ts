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
  /** Resolved public channel identity, when the run has one. */
  youtubeUcId?: string | null;
  /** Additive channel-intelligence summary returned for resolved channel runs. */
  channelSummary?: SpyChannelSummary | null;
}

// ── Spy public channel intelligence (C1) ───────────────────────────────────

export const LOCAL_DESKTOP_WATCHLIST_ID = 'local-desktop';

export type SpyWatchlistSegment = 'saved' | 'followed';
export type SpyWatchStatus = 'followed' | 'paused';
export type SpyCadence = 'daily' | 'manual';

/** Public channel identity plus additive saved/watch-list state. */
export interface SpyChannelSummary {
  youtubeUcId: string;
  title: string | null;
  handle: string | null;
  canonicalUrl?: string | null;
  thumbnailUrl?: string | null;
  starred: boolean;
  starredAt?: string | null;
  watchStatus: SpyWatchStatus | null;
  cadence: SpyCadence | null;
  lastObservedAt: string | null;
  lastObservationStatus?: SpyPublicObservationRun['status'] | null;
  lastObservationCompleteness?: SpyPublicObservationRun['completeness'] | null;
  comparableVph24hCount?: number | null;
  medianVph24h?: number | null;
  nextDueAt?: string | null;
  note: string | null;
}

/** Contract name used by the daemon's channel-intelligence read model. */
export type ChannelSummary = SpyChannelSummary;

export interface SpyWatchlistChannelsResponse {
  channels: SpyChannelSummary[];
  nextCursor: string | null;
}

export interface SpyPublicObservationRun {
  id: string;
  providerUsed: 'ytdlp';
  status: 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'unavailable';
  completeness: 'complete' | 'partial' | 'unavailable';
  startedAt: string;
  completedAt: string | null;
  inspectAttempted: number;
  inspectOk: number;
}

export interface SpyPublicVphSegment {
  sourceVideoId: string;
  title: string | null;
  publishedAt: string | null;
  durationSec: number | null;
  requestedWindow: '1h' | '24h' | '7d';
  actualElapsedHours: number | null;
  value: number | null;
  method: 'deterministic' | 'insufficient_sample' | 'unavailable';
  comparability: 'comparable_1h' | 'comparable_24h' | 'comparable_7d' | 'not_comparable_to_1h' | 'not_comparable_to_24h' | 'not_comparable_to_7d' | 'stretched' | 'coverage_daily_only' | 'insufficient_sample' | 'unavailable';
  reason?: string;
  start: { sampledAt: string; viewCount: number } | null;
  end: { sampledAt: string; viewCount: number } | null;
  availability: 'present' | 'missing' | 'private' | 'error' | null;
  viewQuality: 'known' | 'unknown' | 'decreased_vs_prior' | null;
  inspectUsed: boolean | null;
  providerUsed: 'ytdlp';
  definitionVersion: 'vph/v1';
}

export interface SpyPublicVphQuery {
  window?: '1h' | '24h' | '7d';
  from?: string;
  to?: string;
  ageBucket?: '0-48h' | '2-7d' | '7-30d';
  durationBucket?: 'short' | 'medium' | 'long';
  publishedWeekday?: number;
  includeNonComparable?: boolean;
  cursor?: string;
}

export interface SpyPublicVphRead {
  youtubeUcId: string;
  requestedWindow: '1h' | '24h' | '7d';
  definitionVersion: 'vph/v1';
  timezone: string;
  observedAt: string | null;
  provenance: { visibility: 'public'; providerUsed: 'ytdlp'; dataApiUsed: false; definitionVersion: 'vph/v1' };
  coverage: {
    rawPointCount: number;
    videoCount: number;
    latestRunStatus: SpyPublicObservationRun['status'] | null;
    latestRunCompleteness: SpyPublicObservationRun['completeness'] | null;
    latestRunAt: string | null;
    inspectedVideoCount: number;
    unavailablePointCount: number;
    truncated: boolean;
    nextCursor: string | null;
  };
  videos: Array<{
    sourceVideoId: string; title: string | null; publishedAt: string | null; durationSec: number | null;
    latestSampledAt: string | null; latestViewCount: number | null;
    availability: SpyPublicVphSegment['availability']; viewQuality: SpyPublicVphSegment['viewQuality']; inspectUsed: boolean | null;
  }>;
  vphSegments: SpyPublicVphSegment[];
  vphTimeline: SpyPublicVphSegment[];
  aggregations: {
    medianVph: number | null; comparableCount: number; measuredCount: number; unavailableCount: number;
    cohorts: Array<{ ageBucket: '0-48h' | '2-7d' | '7-30d'; sampleCount: number; medianVph: number | null; p25: number | null; p75: number | null; reason?: 'insufficient_sample' }>;
  };
  /** Compatibility alias for the existing table/chart component. */
  segments: SpyPublicVphSegment[];
  medianVph24h: number | null;
  comparableCount: number;
  notes: string[];
}

export interface SpyPublicVideoVphRead {
  sourceVideoId: string;
  youtubeUcId: string;
  requestedWindow: SpyPublicVphRead['requestedWindow'];
  definitionVersion: 'vph/v1';
  timezone: string;
  provenance: SpyPublicVphRead['provenance'];
  coverage: Pick<SpyPublicVphRead['coverage'], 'rawPointCount' | 'truncated' | 'nextCursor' | 'unavailablePointCount'>;
  rawPoints: Array<{
    id: string; observationRunId: string; sourceVideoId: string; youtubeUcId: string | null; sampledAt: string;
    viewCount: number | null; likeCount: number | null; commentCount: number | null; durationSec: number | null;
    publishedAt: string | null; title: string | null; availability: SpyPublicVphSegment['availability'];
    viewQuality: SpyPublicVphSegment['viewQuality']; providerUsed: 'ytdlp'; inspectUsed: boolean; createdAt: string;
  }>;
  vphSegments: SpyPublicVphSegment[];
}

export interface ChannelWatchSettings {
  enabled: boolean;
  timezone: string;
  dailyHourLocal: string;
  playlistLimit: number;
  inspectCap: number;
  perRelationWallClockMs: number;
}

export interface SpyStarChannelResponse {
  youtubeUcId: string;
  starred: boolean;
  starredAt?: string;
}

export interface SpyCompetitorResponse {
  watchlistId: string;
  competitorChannelId: string;
  watchStatus: SpyWatchStatus;
  cadence: SpyCadence;
  lastObservedAt: string | null;
  nextDueAt?: string | null;
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
  audience?: string;
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

export interface ChannelProfile {
  id: string;
  displayName: string;
  topic: string;
  youtubeIds: string[];
  audience?: string;
  defaultGeneralPack?: string;
  defaultFormulaId?: string;
  defaultStyle?: string;
  defaultProcedure?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EditorialNotebook {
  channelId: string;
  path: string;
  markdown: string;
  hash: string;
  wordCount: number;
}

export type LessonKind = 'KEEP' | 'AVOID' | 'TRY';

export interface EditorialSuggestion {
  kind: LessonKind;
  text: string;
  reason?: string;
  sourceRunId?: string;
}

export interface ReusableProcedure {
  id: string;
  description: string;
  instructions: string;
  path: string;
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

export type WriterV2Phase = 'CONFIGURING' | 'READY' | 'STUDY' | 'WRITE' | 'GATE' | 'EDIT_REVIEW' | 'REPAIR' | 'DONE' | 'FAILED';

export type WriterV2ActiveRoleKind = 'author' | 'critic' | 'gate' | 'none';

export interface WriterV2ActiveRole {
  kind: WriterV2ActiveRoleKind;
  label: string;
  agentId?: string;
}

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

/**
 * Where a run's agent turns execute. `terminal` = the app's turn bridge opens a
 * read-only pane per turn (today's behaviour). `external` = an orchestrator on
 * 1DevTool runs each stage itself through the Writer MCP; the daemon emits no
 * `spawnTurn`, so the app only watches progress. Set on the post while DRAFT.
 */
export type WriterSubstrate = 'terminal' | 'external';

/** Handles the external orchestrator reports for a turn (all optional). */
export interface WriterExternalRef {
  runId?: string;
  teamId?: string;
  memberId?: string;
  terminalId?: string;
}

/** One progress note on a run; daemon keeps at most the last 50. */
export interface WriterTimelineEntry {
  at: string;
  turnId?: number;
  stage?: string;
  kind: 'note' | 'external' | 'system';
  text: string;
  external?: WriterExternalRef;
}

export interface WriterResearchSourceCheckpoint {
  videoId: string;
  itemId: string;
  sourceHash: string;
  status: 'PENDING' | 'RUNNING' | 'COMMITTED' | 'FAILED' | 'INTERRUPTED';
  attempt: number;
  turnIds: number[];
  activeTurnId?: number;
  artifactHash?: string;
  artifactPath?: string;
  errorCode?: string;
  errorReason?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface WriterTopicPackCheckpoint {
  path: string;
  hash: string;
  researchMapPath: string;
  researchMapHash: string;
  sourcePackHash: string;
  videoIds: string[];
  createdAt: string;
}

/** The turn currently open on a run; only present on single-run GET responses. */
export interface WriterCurrentTurn {
  turnId: number;
  stage: string;
  attempt: number;
  /** Clone id the daemon booked the turn on. */
  agentId: string;
  /** Template id (`claude`, `codex`); absent on older daemons. */
  templateId?: string;
  itemRunDir: string;
  startedAt: string;
  deadlineAt: string;
  external?: WriterExternalRef;
}

export interface WriterRunV2 {
  id: string;
  status: 'DRAFT' | 'RUNNING' | 'DONE' | 'FAILED' | 'FAILED_GATE';
  phase: WriterV2Phase;
  brief: string;
  requestedTitle?: string;
  targetWords?: number;
  audience?: string;
  channelId?: string;
  editorialPath?: string;
  editorialHash?: string;
  procedureId?: string;
  procedureHash?: string;
  packId: string;
  packTitle: string;
  packHash?: string;
  researchSources?: WriterResearchSourceCheckpoint[];
  topicPack?: WriterTopicPackCheckpoint;
  generalPackPath: string;
  generalPackHash: string;
  generalPackVersion: number | null;
  /** @deprecated SDD 006: Formula is no longer a Writer v2 input — always blank/0 on a new run. */
  formulaId: string;
  /** @deprecated SDD 006 — see `formulaId`. */
  formulaVersion: number;
  /** @deprecated SDD 006 — see `formulaId`. */
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
  reviewingPostmortem?: { attempt: number; startedAt: string };
  postmortemAttempt?: number;
  postmortem?: {
    lessons: Array<{ kind: LessonKind; text: string; reason: string }>;
    agentId: string;
    createdAt: string;
  };
  postmortemError?: { code: string; reason: string; at: string };
  generatingHook?: { step: 'clarify' | 'suggest'; attempt: number; startedAt: string };
  hookTurnAttempt?: number;
  hookClarify?: { questions: string[]; answers?: string[] };
  hookCandidates?: Array<{ id: string; type: string; typeLabel: string; text: string }>;
  selectedHook?: { id: string; type: string; typeLabel: string; text: string };
  hookLibraryHash?: string;
  hookError?: { code: string; reason: string; at: string };
  createdAt: string;
  updatedAt: string;
  errorCode?: string;
  errorReason?: string;
  /** Weighted Director-board progress (0–100). Computed by daemon on read. */
  progressPercent?: number;
  activeRole?: WriterV2ActiveRole;
  /** Missing on runs written before substrates existed — treat as `terminal`. */
  substrate?: WriterSubstrate;
  timeline?: WriterTimelineEntry[];
  /** Computed by daemon on single-run GET; `null` when no turn is open. */
  currentTurn?: WriterCurrentTurn | null;
}

export interface WriterRunV2Summary {
  id: string;
  status: WriterRunV2['status'];
  phase: WriterV2Phase;
  brief: string;
  requestedTitle?: string;
  targetWords?: number;
  audience?: string;
  channelId?: string;
  packId: string;
  packTitle: string;
  packHash?: string;
  generalPackPath: string;
  generalPackHash: string;
  generalPackVersion: number | null;
  /** @deprecated SDD 006: Formula is no longer a Writer v2 input — always blank/0 on a new run. */
  formulaId: string;
  /** @deprecated SDD 006 — see `formulaId`. */
  formulaVersion: number;
  /** @deprecated SDD 006 — see `formulaId`. */
  formulaHash: string;
  agentId: string;
  editorAgentId: string;
  substrate?: WriterSubstrate;
  createdAt: string;
  updatedAt: string;
  hasScript: boolean;
  gateViolationCount: number;
  defectCount: number;
  styledCount: number;
  hasPostmortem: boolean;
  reviewingPostmortem: boolean;
  progressPercent?: number;
  activeRole?: WriterV2ActiveRole;
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

/** Beat grammar (SDD 006 §3) — mirrors `packages/daemon/src/writer/video-plan.ts`. */
export type WriterBeatMode = 'canh' | 'mo-so' | 'phan-bac' | 'cuc-tri' | 'zoom-chu' | 'doi-y';
export type WriterBeatTurn =
  | 'doi-don-vi' | 'doi-chu-the' | 'doi-thang' | 'doi-ten' | 'doi-thoi-diem' | 'doi-cau-hoi';
export type WriterFrameKind = 'nhan-vat' | 'an-du' | 'con-so';

export interface WriterVideoPlan {
  coreInsight: string;
  memoryAnchor: {
    kind: 'name' | 'equation' | 'contrast' | 'image';
    value: string;
  };
  /** The one thread that runs through the whole piece (SDD 006 §3 Khuôn table). */
  frame: {
    kind: WriterFrameKind;
    value: string;
  };
  progression: Array<{
    beat: string;
    newInformation: string;
    characterOrArgumentChange: string;
    visualAnchor: string;
    /** How this beat is played (SDD 006 §3 Mode table). */
    mode: WriterBeatMode;
    /** The lateral turn applied to `familiarObject` (SDD 006 §3 Phép lật table). */
    turn: WriterBeatTurn;
    familiarObject: string;
    whyNotEarlier: string;
  }>;
  endingPayoff: {
    resolvesOpening: string;
    audienceCanDo: string;
    /** The straight answer to the hook's question the ending must NOT be. */
    directAnswer: string;
    /** The hook's question, reframed — this is what the ending actually resolves to. */
    reframedQuestion: string;
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

// ── Spy Auto-Loop types ─────────────────────────────────────────────────────

export type TopicStatus = 'active' | 'paused' | 'archived';

export interface Topic {
  topicId: string;
  label: string;
  market: string;
  language: string;
  status: TopicStatus;
  ownChannelIds: string[];
  briefMd: string;
  facelessRequired: boolean;
  dailySearchBudget: number;
  createdAt: string;
  updatedAt: string;
}

export type LoopTickStatus = 'running' | 'done' | 'failed' | 'skipped_quota';

export interface LoopStatus {
  topicId: string;
  topicLabel: string;
  topicStatus: TopicStatus;
  lastTick: {
    tickId: string;
    quotaDay: string;
    status: LoopTickStatus;
    step: string;
    startedAt: string;
    finishedAt: string | null;
    error: string | null;
  } | null;
  nextTickAt: string | null;
  inboxTotal: number;
  shortlistedTotal: number;
  studiedTotal: number;
  keywordsPending: number;
  quota: {
    searchUsed: number;
    searchBudget: number;
    searchRemainingDay: number;
    generalUsed: number;
    generalLimit: number;
  } | null;
}

export type LoopCapabilityState = 'available' | 'unavailable' | 'legacy' | 'not_configured';

export interface LoopCapability {
  id: string;
  label: string;
  state: LoopCapabilityState;
  detail: string;
}

export interface LoopCapabilityStatus {
  phase: '0.1';
  readOnly: true;
  generatedAt: string;
  capabilities: LoopCapability[];
}

export interface P0ArtifactRef {
  hash: string;
  relativePath: string;
  byteLength: number;
  mimeType: string;
}

export interface P0CorpusImportItem {
  id: string;
  batchId: string;
  submittedUrl: string;
  canonicalUrl: string;
  sourceVideoId: string;
  identityStatus: 'verified' | 'needs_identity';
  capturedAt: string;
  expiresAt: string;
  status: 'draft' | 'confirmed' | 'rejected';
  promotedMembershipId: string | null;
}

export interface P0CorpusImportBatch {
  id: string;
  topicId: string;
  status: 'draft' | 'confirmed' | 'rejected';
  createdAt: string;
  items: P0CorpusImportItem[];
}

export interface P0EvidenceRecord {
  id: string;
  kind: 'metadata' | 'transcript' | 'thumbnail';
  status: 'available' | 'unavailable' | 'failed' | 'expired';
  method: string;
  observedAt: string;
  expiresAt: string;
  detail: Record<string, unknown>;
}

export interface P0AnalysisRun {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'expired';
  model: string;
  createdAt: string;
  expiresAt: string;
  result: { labels: string[]; keywordCandidates: string[]; claims: Array<{ text: string; evidenceIds: string[] }> } | null;
  failureCode: string | null;
  failureReason: string | null;
}

export interface P0Membership {
  id: string;
  canonicalUrl: string;
  sourceVideoId: string;
  status: 'confirmed' | 'expired';
  identityStatus: 'verified' | 'needs_identity';
  createdFromKind: 'corpus_import' | 'recommendation';
  evidence: P0EvidenceRecord[];
  analyses: P0AnalysisRun[];
}

export interface P0RecommendationObservation {
  id: string;
  fromVideoId: string;
  targetVideoId: string;
  targetCanonicalUrl: string;
  targetTitle: string | null;
  targetChannelTitle: string | null;
  observedPosition: number;
  status: 'draft' | 'confirmed' | 'rejected' | 'expired';
  expiresAt: string;
}

export interface P0RecommendationBatch {
  id: string;
  fromVideoId: string;
  seedCanonicalUrl: string;
  status: 'capturing' | 'draft' | 'failed' | 'expired';
  captureMethod: string | null;
  capturedAt: string | null;
  expiresAt: string | null;
  failureReason: string | null;
  observations: P0RecommendationObservation[];
}

export interface P0CorpusOverview {
  topicId: string;
  enabled: boolean;
  imports: P0CorpusImportBatch[];
  memberships: P0Membership[];
  recommendationBatches: P0RecommendationBatch[];
  loopRuns: Array<{ id: string; status: 'running' | 'completed' | 'failed' | 'blocked'; phase: string; resumeIndex: number; errorMessage: string | null; createdAt: string }>;
  reports: Array<{ id: string; loopRunId: string; summary: Record<string, unknown>; createdAt: string }>;
}

export interface InboxItem {
  channelId: string;
  title: string | null;
  handle: string | null;
  url: string;
  thumbnails: string[];        // ≤6 hqdefault URLs; P0 thường rỗng (chưa persist)
  subscriberCount: number | null;
  videoCount: number | null;
  country: string | null;
  publishedAt: string | null;
  medianViews: number | null;
  medianViewsVsOwn: number | null;
  fitScore: number | null;
  fitReasons: string[];
  /**
   * VERDICT faceless — do agent vision chấm. **Luôn `null` ở P0.**
   * Chỉ giá trị này mới được hiển thị như một kết luận.
   */
  facelessScore: number | null;
  /** Evidence ref của verdict. P0 luôn rỗng. */
  facelessSignals: string[];
  /**
   * PHỎNG ĐOÁN từ title/description (0..1). KHÔNG phải kết luận — UI bắt buộc
   * gắn nhãn "đoán từ chữ" và không được dùng để auto-reject.
   */
  facelessHint: number | null;
  facelessHintReasons: string[];
  learnValueScore: number | null;
  learnValueReasons: string[];
  langDetected: string | null;
  langConfidence: number | null;
  /**
   * Bằng chứng ngôn ngữ. CHỈ được trình bày như lý do loại kênh khi
   * `canJustifyRejection` là true (tức method === 'declared_fields').
   * 'title_heuristic' là phỏng đoán đã ghi lại — loop không bao giờ reject vì nó,
   * nên UI cũng không được đọc nó như một phán quyết.
   */
  langEvidence: LangEvidence | null;
  foundVia: { relation: string; term: string | null; fromChannelId: string | null };
  status: string;
  decidedBy: string | null;
  /** Lý do máy đọc được khi loop tự quyết ('lang_mismatch', 'low_fit', …). */
  decidedReason: string | null;
  decidedAt: string | null;
  firstSeenAt: string;
}

export interface LangEvidence {
  method: string;
  evidenceField: string | null;
  declaredByField: Record<string, number>;
  declaredCount: number | null;
  sampleSize: number | null;
  majority: string | null;
  canJustifyRejection: boolean;
  summary: string;
}

export type KeywordStatus = 'pending' | 'searched' | 'exhausted' | 'rejected';

export interface Keyword {
  topicId: string;
  termKey: string;
  displayTerm: string;
  relation: string;
  status: KeywordStatus;
  yieldChannels: number;
  lastSearchedAt: string | null;
  addedAt: string;
  addedBy: string;
}

export interface TickPlan {
  topicId: string;
  quotaDay: string;
  dryRun: true;
  steps: Array<{
    step: string;
    estimatedSearchCalls: number;
    estimatedGeneralUnits: number;
    keywords: string[];
    note: string;
  }>;
  totalSearchCalls: number;
  totalGeneralUnits: number;
  canProceed: boolean;
  warnings: string[];
}

export interface StoredReport {
  reportId: string;
  reportDate: string;
  topicId: string | null;
  summary: ReportSummaryJson | null;
  markdown: string;
  createdAt: string;
  deliveredJson: Record<string, string>;
}

export interface ReportSummaryJson {
  version: number;
  reportId: string;
  reportDate: string;
  topicId: string | null;
  topicLabel: string;
  tick: {
    tickId: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    durationSec: number | null;
    error: string | null;
    dryRun: boolean;
  };
  quota: {
    searchUsed: number;
    searchBudget: number;
    searchRemainingDay: number;
    generalUsed: number;
    generalLimit: number;
  };
  funnel: {
    expanded: number;
    searched: number;
    newCandidates: number;
    autoShortlisted: number;
    pendingReview: number;
    autoRejected: number;
    scanned: number;
    keywordsHarvested: number;
  };
  inboxTotal: number;
  topLearn: Array<{
    channelId: string;
    title: string;
    url: string;
    subscriberCount: number | null;
    ageMonths: number | null;
    medianViews: number | null;
    medianViewsVsOwn: number | null;
    ownChannelTitle: string | null;
    /** Verdict — null ở P0. */
    facelessScore: number | null;
    fitScore: number | null;
    learnValueScore: number | null;
    foundVia: { relation: string; term: string | null };
    status: string;
    decidedBy: string | null;
    why: string[];
  }>;
  newKeywords: string[];
  exhaustedKeywords: Array<{ term: string; rejectRate: number; yieldChannels: number }>;
  scannedChannels: Array<{ channelId: string; title: string; spyRunId: string | null; topTitlePattern: string | null; outliers: string[] }>;
  delta: {
    vsReportId: string | null;
    vsDate: string | null;
    newCandidatesPrev: number | null;
    inboxTotalPrev: number | null;
    shortlistedTotalPrev: number | null;
    studiedTotalPrev: number | null;
    keywordsPendingPrev: number | null;
    firstSeenToday: string[];
    movedToShortlistToday: string[];
    userDecisionsSinceLast: { shortlisted: number; rejected: number };
    newlyExhausted: string[];
  };
  warnings: string[];
  links: { dashboard: string; mcpTool: string };
}

/**
 * Bản public của `config/spy-loop.json` (FILE RIÊNG — không bao giờ ghi chung
 * `spy.json`, vì `spyConfigSchema` là `.strict()` và một key lạ sẽ làm mất
 * `youtubeDataApiKey`). `botToken` không bao giờ rời server.
 */
export interface SpyLoopSettings {
  enabled: boolean;
  tickHourLocal: string;    // "HH:MM"
  digestHourLocal: string;  // "HH:MM"
  timezone: string;
  telegram?: {
    chatId: string;
    enabled: boolean;
    botTokenSet: boolean;
  };
}

function spyVphQuerySuffix(query?: SpyPublicVphQuery): string {
  const params = new URLSearchParams();
  if (query?.window) params.set('window', query.window);
  if (query?.from) params.set('from', query.from);
  if (query?.to) params.set('to', query.to);
  if (query?.ageBucket) params.set('ageBucket', query.ageBucket);
  if (query?.durationBucket) params.set('durationBucket', query.durationBucket);
  if (query?.publishedWeekday !== undefined) params.set('publishedWeekday', String(query.publishedWeekday));
  if (query?.includeNonComparable !== undefined) params.set('includeNonComparable', String(query.includeNonComparable));
  if (query?.cursor) params.set('cursor', query.cursor);
  return params.size > 0 ? `?${params}` : '';
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

  // ── Spy public channel intelligence (C1) ────────────────────────────────
  listSpyWatchlistChannels: (watchlistId: string, segment: SpyWatchlistSegment) =>
    request<SpyWatchlistChannelsResponse>(
      `/api/spy/watchlists/${encodeURIComponent(watchlistId)}/channels?segment=${encodeURIComponent(segment)}`,
    ),
  starSpyChannel: (youtubeUcId: string, note?: string) =>
    request<SpyStarChannelResponse>(
      `/api/spy/channels/${encodeURIComponent(youtubeUcId)}/star`,
      { method: 'PUT', body: JSON.stringify(note ? { note } : {}) },
    ),
  unstarSpyChannel: (youtubeUcId: string) =>
    request<SpyStarChannelResponse>(
      `/api/spy/channels/${encodeURIComponent(youtubeUcId)}/star`,
      { method: 'DELETE' },
    ),
  followSpyChannel: (watchlistId: string, youtubeUcId: string, body?: {
    note?: string;
    cadence?: SpyCadence;
    watchStatus?: 'followed';
  }) =>
    request<SpyCompetitorResponse>(
      `/api/spy/watchlists/${encodeURIComponent(watchlistId)}/competitors/${encodeURIComponent(youtubeUcId)}`,
      { method: 'PUT', body: JSON.stringify(body ?? { cadence: 'daily', watchStatus: 'followed' }) },
    ),
  pauseSpyChannel: (watchlistId: string, youtubeUcId: string) =>
    request<SpyCompetitorResponse>(
      `/api/spy/watchlists/${encodeURIComponent(watchlistId)}/competitors/${encodeURIComponent(youtubeUcId)}`,
      { method: 'PATCH', body: JSON.stringify({ watchStatus: 'paused' }) },
    ),
  unfollowSpyChannel: (watchlistId: string, youtubeUcId: string) =>
    request<SpyCompetitorResponse>(
      `/api/spy/watchlists/${encodeURIComponent(watchlistId)}/competitors/${encodeURIComponent(youtubeUcId)}`,
      { method: 'DELETE' },
    ),
  observeSpyChannel: (watchlistId: string, youtubeUcId: string, body?: { playlistLimit?: number; inspectCap?: number }) =>
    request<{ run: SpyPublicObservationRun; reused: boolean; inspected: number; notes: string[] }>(
      `/api/spy/watchlists/${encodeURIComponent(watchlistId)}/competitors/${encodeURIComponent(youtubeUcId)}/observe`,
      { method: 'POST', body: JSON.stringify(body ?? {}) },
    ),
  getSpyChannelVph: (watchlistId: string, youtubeUcId: string, query?: SpyPublicVphQuery) => {
    const suffix = spyVphQuerySuffix(query);
    return request<SpyPublicVphRead>(
      `/api/spy/watchlists/${encodeURIComponent(watchlistId)}/competitors/${encodeURIComponent(youtubeUcId)}/vph${suffix}`,
    );
  },
  getSpyVideoVph: (sourceVideoId: string, query?: SpyPublicVphQuery) =>
    request<SpyPublicVideoVphRead>(`/api/spy/videos/${encodeURIComponent(sourceVideoId)}/vph${spyVphQuerySuffix(query)}`),
  getChannelWatchSettings: () => request<ChannelWatchSettings>('/api/settings/channel-watch'),
  updateChannelWatchSettings: (patch: Partial<ChannelWatchSettings>) =>
    request<ChannelWatchSettings>('/api/settings/channel-watch', { method: 'PUT', body: JSON.stringify(patch) }),

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


  // ── Write Loop v2 ────────────────────────────────────────────────────────
  listChannelProfiles: () => request<{ channels: ChannelProfile[] }>('/api/writer/channels'),
  getChannelProfile: (id: string) =>
    request<ChannelProfile>(`/api/writer/channels/${encodeURIComponent(id)}`),
  createChannelProfile: (body: Omit<ChannelProfile, 'createdAt' | 'updatedAt'>) =>
    request<ChannelProfile>('/api/writer/channels', { method: 'POST', body: JSON.stringify(body) }),
  updateChannelProfile: (id: string, body: Omit<ChannelProfile, 'id' | 'createdAt' | 'updatedAt'>) =>
    request<ChannelProfile>(`/api/writer/channels/${encodeURIComponent(id)}`, {
      method: 'PUT', body: JSON.stringify(body),
    }),
  getEditorialNotebook: (channelId: string) =>
    request<EditorialNotebook>(`/api/writer/channels/${encodeURIComponent(channelId)}/editorial`),
  updateEditorialNotebook: (channelId: string, markdown: string, expectedHash: string) =>
    request<EditorialNotebook>(`/api/writer/channels/${encodeURIComponent(channelId)}/editorial`, {
      method: 'PUT', body: JSON.stringify({ markdown, expectedHash }),
    }),
  listEditorialSuggestions: (channelId: string) =>
    request<{ suggestions: EditorialSuggestion[] }>(
      `/api/writer/channels/${encodeURIComponent(channelId)}/inbox`,
    ),
  addEditorialSuggestion: (channelId: string, suggestion: EditorialSuggestion) =>
    request<{ added: EditorialSuggestion[] }>(`/api/writer/channels/${encodeURIComponent(channelId)}/inbox`, {
      method: 'POST', body: JSON.stringify({ suggestion }),
    }),
  approveEditorialSuggestion: (channelId: string, suggestion: EditorialSuggestion) =>
    request<EditorialNotebook>(`/api/writer/channels/${encodeURIComponent(channelId)}/inbox/approve`, {
      method: 'POST', body: JSON.stringify({ suggestion }),
    }),
  dismissEditorialSuggestion: (channelId: string, suggestion: EditorialSuggestion) =>
    request<{ ok: boolean }>(`/api/writer/channels/${encodeURIComponent(channelId)}/inbox/dismiss`, {
      method: 'POST', body: JSON.stringify({ suggestion }),
    }),
  listReusableProcedures: () => request<{ procedures: ReusableProcedure[] }>('/api/writer/procedures'),
  getReusableProcedure: (id: string) =>
    request<ReusableProcedure>(`/api/writer/procedures/${encodeURIComponent(id)}`),
  createReusableProcedure: (body: { id: string; description: string; instructions: string }) =>
    request<ReusableProcedure>('/api/writer/procedures', { method: 'POST', body: JSON.stringify(body) }),
  updateReusableProcedure: (id: string, body: { description: string; instructions: string }) =>
    request<ReusableProcedure>(`/api/writer/procedures/${encodeURIComponent(id)}`, {
      method: 'PUT', body: JSON.stringify(body),
    }),
  listGeneralPacks: () => request<{ packs: GeneralPackSummary[] }>('/api/writer/general-packs'),
  getGeneralPack: (path: string) =>
    request<GeneralPackSummary & { markdown: string }>(
      `/api/writer/general-packs/${encodeURIComponent(path)}`,
    ),
  listWriterRunsV2: () => request<{ runs: WriterRunV2Summary[] }>('/api/writer/v2/runs'),
  getWriterRunV2: (id: string) =>
    request<WriterRunV2>(`/api/writer/v2/runs/${encodeURIComponent(id)}`),
  startWriterRunV2: (body: {
    channelId: string;
    brief: string;
    title?: string;
    audience?: string;
    targetWords?: number;
    packId: string;
    generalPack: string;
    /** @deprecated SDD 006: Formula is no longer a Writer v2 input; ignored by the server. */
    formulaId?: string;
    agentId?: string;
    editorAgentId?: string;
    substrate?: WriterSubstrate;
  }) =>
    request<WriterRunV2>('/api/writer/v2/runs', { method: 'POST', body: JSON.stringify(body) }),
  listWriterPostsV2: () => request<{ posts: WriterRunV2Summary[] }>('/api/writer/v2/posts'),
  getWriterPostV2: (id: string) =>
    request<WriterRunV2>(`/api/writer/v2/posts/${encodeURIComponent(id)}`),
  createWriterPostV2: (body: { substrate?: WriterSubstrate } = {}) =>
    request<WriterRunV2>('/api/writer/v2/posts', { method: 'POST', body: JSON.stringify(body) }),
  updateWriterPostV2: (id: string, body: {
    channelId: string;
    brief: string;
    title?: string;
    audience?: string;
    targetWords?: number;
    packId: string;
    generalPack: string;
    /** @deprecated SDD 006: Formula is no longer a Writer v2 input; ignored by the server. */
    formulaId?: string;
    agentId: string;
    editorAgentId: string;
    /** Server accepts it only while the post is DRAFT. */
    substrate?: WriterSubstrate;
  }) => request<WriterRunV2>(`/api/writer/v2/posts/${encodeURIComponent(id)}`, {
    method: 'PUT', body: JSON.stringify(body),
  }),
  runWriterPostV2: (id: string) =>
    request<WriterRunV2>(`/api/writer/v2/posts/${encodeURIComponent(id)}/run`, {
      method: 'POST', body: JSON.stringify({}),
    }),
  startHookClarify: (id: string) =>
    request<WriterRunV2>(`/api/writer/v2/posts/${encodeURIComponent(id)}/hook/clarify`, {
      method: 'POST', body: JSON.stringify({}),
    }),
  startHookSuggest: (id: string, answers: string[]) =>
    request<WriterRunV2>(`/api/writer/v2/posts/${encodeURIComponent(id)}/hook/suggest`, {
      method: 'POST', body: JSON.stringify({ answers }),
    }),
  selectWriterHook: (id: string, selectedId: string) =>
    request<WriterRunV2>(`/api/writer/v2/posts/${encodeURIComponent(id)}/hook/selection`, {
      method: 'PUT', body: JSON.stringify({ selectedId }),
    }),
  createWriterRoomV2: (body: {
    channelId: string;
    brief: string;
    title?: string;
    audience?: string;
    targetWords?: number;
    packId: string;
    generalPack: string;
    /** @deprecated SDD 006: Formula is no longer a Writer v2 input; ignored by the server. */
    formulaId?: string;
    agentId?: string;
    editorAgentId?: string;
    substrate?: WriterSubstrate;
  }) =>
    request<WriterRunV2>('/api/writer/v2/rooms', { method: 'POST', body: JSON.stringify(body) }),
  runWriterRoomV2: (id: string) =>
    request<WriterRunV2>(`/api/writer/v2/rooms/${encodeURIComponent(id)}/run`, {
      method: 'POST', body: JSON.stringify({}),
    }),
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
  startWriterPostmortem: (id: string) =>
    request<WriterRunV2>(`/api/writer/v2/runs/${encodeURIComponent(id)}/postmortem`, {
      method: 'POST', body: JSON.stringify({}),
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

  // ── Spy Auto-Loop ──────────────────────────────────────────────────────────
  listTopics: () => request<{ topics: Topic[] }>('/api/spy/topics'),
  createTopic: (body: { topicId: string; label: string; market: string; language: string; ownChannelIds?: string[]; facelessRequired?: boolean; dailySearchBudget?: number }) =>
    request<{ topic: Topic }>('/api/spy/topics', { method: 'POST', body: JSON.stringify(body) }),
  patchTopic: (topicId: string, body: Partial<Pick<Topic, 'label' | 'status' | 'dailySearchBudget' | 'facelessRequired'>>) =>
    request<{ topic: Topic }>(`/api/spy/topics/${encodeURIComponent(topicId)}`, { method: 'PATCH', body: JSON.stringify(body) }),

  loopStatus: (topicId: string) =>
    request<LoopStatus>(`/api/spy/loop/status?topic=${encodeURIComponent(topicId)}`),

  loopCapabilities: () =>
    request<LoopCapabilityStatus>('/api/spy/loop/capabilities'),

  p0CorpusOverview: (topicId: string) =>
    request<P0CorpusOverview>(`/api/spy/p0/overview?topic=${encodeURIComponent(topicId)}`),
  p0ImportCorpusVideo: (body: { topicId: string; url: string; idempotencyKey: string }) =>
    request<{ batch: P0CorpusImportBatch; reused: boolean }>('/api/spy/p0/corpus-imports', {
      method: 'POST', body: JSON.stringify(body),
    }),
  p0DecideCorpusImport: (batchId: string, decision: 'confirm' | 'reject') =>
    request<{ batch: P0CorpusImportBatch; memberships?: P0Membership[] }>(
      `/api/spy/p0/corpus-imports/${encodeURIComponent(batchId)}/${decision}`, { method: 'POST', body: JSON.stringify({}) },
    ),
  p0CaptureSuggestions: (body: { topicId: string; seedMembershipId: string; idempotencyKey: string }) =>
    request<{ batch: P0RecommendationBatch; reused: boolean }>('/api/spy/p0/recommendation-captures', {
      method: 'POST', body: JSON.stringify(body),
    }),
  p0DecideSuggestion: (observationId: string, decision: 'confirm' | 'reject') =>
    request<{ observation: P0RecommendationObservation; membership: P0Membership | null }>(
      `/api/spy/p0/recommendation-observations/${encodeURIComponent(observationId)}/${decision}`, { method: 'POST', body: JSON.stringify({}) },
    ),
  p0EnrichMembership: (membershipId: string) =>
    request<{ evidence: P0EvidenceRecord[] }>(`/api/spy/p0/memberships/${encodeURIComponent(membershipId)}/enrich`, {
      method: 'POST', body: JSON.stringify({}),
    }),
  p0AnalysisManifest: (membershipId: string) =>
    request<{
      digest: string; expiresAt: string; policyVersion: string | null;
      target: { membershipId: string | null; canonicalUrl: string | null; sourceVideoId: string | null };
      evidence: Array<{ evidenceId: string | null; kind: string | null; method: string | null; observedAt: string | null; expiresAt: string | null; detail: Record<string, string | number> }>;
    }>(
      `/api/spy/p0/memberships/${encodeURIComponent(membershipId)}/analysis-manifest`,
    ),
  p0AnalyzeMembership: (membershipId: string, body: { topicId: string; idempotencyKey: string }) =>
    request<{ run: P0AnalysisRun; reused: boolean }>(`/api/spy/p0/memberships/${encodeURIComponent(membershipId)}/analyze`, {
      method: 'POST', body: JSON.stringify(body),
    }),
  p0SetLoopEnabled: (topicId: string, enabled: boolean) =>
    request<{ enabled: boolean }>('/api/spy/p0/controls', { method: 'POST', body: JSON.stringify({ topicId, enabled }) }),
  p0ManualTick: (topicId: string, idempotencyKey: string) =>
    request<{ run: { id: string; status: string; phase: string }; report: { id: string } | null; reused: boolean }>('/api/spy/p0/tick', {
      method: 'POST', body: JSON.stringify({ topicId, idempotencyKey }),
    }),

  loopInbox: (params: { topic: string; status?: string; limit?: number; cursor?: number; sort?: string }) => {
    const q = new URLSearchParams({ topic: params.topic });
    if (params.status) q.set('status', params.status);
    if (params.limit != null) q.set('limit', String(params.limit));
    if (params.cursor != null) q.set('cursor', String(params.cursor));
    if (params.sort) q.set('sort', params.sort);
    return request<{ items: InboxItem[]; total: number; nextCursor: number | null }>(`/api/spy/loop/inbox?${q}`);
  },

  /** `status: 'new'` = undo (phím `u`) — đưa kênh trở lại hàng chờ duyệt. */
  loopDecide: (body: {
    topicId: string;
    channelIds: string[];
    status: 'shortlisted' | 'rejected' | 'new';
    negativeKeyword?: string;
  }) =>
    request<{ updated: number }>('/api/spy/loop/decide', { method: 'POST', body: JSON.stringify(body) }),

  /**
   * Cold start #1 (design §1.2): dán URL kênh / `@handle` / `UC…`.
   * Tốn ~1 unit/50 id (handle thì 1 unit/kênh) — KHÔNG dùng provider ngoài.
   */
  addManualCandidates: (topicId: string, inputs: string[]) =>
    request<{ added: number; skippedKnown: number; notFound: string[] }>(
      '/api/spy/loop/candidates/manual',
      { method: 'POST', body: JSON.stringify({ topicId, inputs }) },
    ),

  /** Cold start #2: nạp kênh đã spy sẵn trong corpus vào topic. 0 quota. */
  importCorpus: (topicId: string) =>
    request<{ added: number; skippedKnown: number }>(
      '/api/spy/loop/import-corpus',
      { method: 'POST', body: JSON.stringify({ topicId }) },
    ),

  loopKeywords: (topicId: string) =>
    request<{ keywords: Keyword[] }>(`/api/spy/loop/keywords?topic=${encodeURIComponent(topicId)}`),

  addKeyword: (body: { topicId: string; displayTerm: string; relation?: string }) =>
    request<{ keyword: Keyword }>('/api/spy/loop/keywords', {
      method: 'POST',
      body: JSON.stringify({ topicId: body.topicId, term: body.displayTerm, relation: body.relation }),
    }),

  decideKeywords: (body: { topicId: string; termKeys: string[]; status: KeywordStatus; negative?: boolean }) =>
    request<{ ok: boolean; updated: number }>('/api/spy/loop/keywords/decide', { method: 'POST', body: JSON.stringify(body) }),

  loopTick: (body: { topicId: string; dryRun?: boolean }) =>
    request<TickPlan | { ok: boolean; running: boolean; dryRun: false }>('/api/spy/loop/tick', { method: 'POST', body: JSON.stringify(body) }),

  loopReports: (topicId: string) =>
    request<{ reports: StoredReport[] }>(`/api/spy/loop/reports?topic=${encodeURIComponent(topicId)}`),

  loopReport: (id: string) =>
    request<StoredReport>(`/api/spy/loop/reports/${encodeURIComponent(id)}`),

  resendReport: (id: string) =>
    request<{ ok: boolean }>(`/api/spy/loop/reports/${encodeURIComponent(id)}/resend`, { method: 'POST' }),

  loopStudied: (topicId: string) =>
    request<{
      channels: Array<{
        channelId: string;
        title: string | null;
        handle: string | null;
        spyRunId: string | null;
        status: string;
        fitScore: number | null;
        learnValueScore: number | null;
        facelessScore: number | null;
        facelessHint: number | null;
        decidedAt: string | null;
      }>;
    }>(`/api/spy/loop/studied?topic=${encodeURIComponent(topicId)}`),

  getSpyLoopSettings: () =>
    request<SpyLoopSettings>('/api/settings/spy-loop'),

  putSpyLoopSettings: (body: {
    enabled?: boolean;
    tickHourLocal?: string;
    digestHourLocal?: string;
    timezone?: string;
    telegram?: { botToken?: string; chatId?: string; enabled?: boolean };
  }) =>
    request<SpyLoopSettings>('/api/settings/spy-loop', { method: 'PUT', body: JSON.stringify(body) }),
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
