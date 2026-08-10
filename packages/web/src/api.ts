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

export interface FormulaSummary {
  id: string;
  status: 'DRAFT' | 'TRIAL' | 'VALIDATED';
  origin: FormulaOrigin;
  version: number;
  /** Channel title for ANALYZED/REFINED, genre for COMPOUND. */
  label: string;
  videoCount: number;
  ruleCount: number;
  createdAt: string;
  sourceBatchId?: string;
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

export interface CritiqueArtifact {
  positivePatterns: CritiquePattern[];
  negativePatterns: CritiquePattern[];
}

export interface TrainingLabRound {
  round: number;
  formulaVersionIn: FormulaVersion;
  draft: DraftArtifact | null;
  draftArtifactHash: string | null;
  critique: CritiqueArtifact | null;
  critiqueArtifactHash: string | null;
  formulaVersionOut: FormulaVersion | null;
  status: 'DRAFTING' | 'CRITIQUING' | 'REFINING' | 'DONE' | 'FAILED';
  errorCode?: string;
}

export interface TrainingLabRun {
  id: string;
  videoSnapshotId: string;
  channelTitle: string;
  status: 'RUNNING' | 'DONE' | 'FAILED';
  maxRounds: number;
  rounds: TrainingLabRound[];
  createdAt: string;
  updatedAt: string;
}

export interface TrainingLabRunSummary {
  id: string;
  videoSnapshotId: string;
  channelTitle: string;
  status: 'RUNNING' | 'DONE' | 'FAILED';
  roundCount: number;
  createdAt: string;
  updatedAt: string;
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
  statement: string;
  sources: RuleSource[];
  decision: 'PENDING' | 'ACCEPTED' | 'REJECTED';
  edited?: boolean;
}

export interface StudioSession {
  id: string;
  genre: string;
  picks: RuleRef[];
  clusters: RuleCluster[];
  proposals: RuleProposal[];
  compound: Formula | null;
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

  listSpyRuns: () => request<{ runs: SpyRunSummary[] }>('/api/spy/runs'),
  getSpyRun: (id: string) => request<{
    run: SpyRunSummary;
    videos: SpyVideoRow[];
  }>(`/api/spy/runs/${id}`),
  getOperation: (id: string) => request<SpyOperation>(`/api/spy/operations/${id}`),

  startChannel: (body: {
    url: string;
    depth?: string;
    topN?: number;
    scanLimit?: number;
  }) => request<SpyStarted>('/api/spy/channel', { method: 'POST', body: JSON.stringify(body) }),

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
    opts: { limit?: number; videoIds?: string[] } = {},
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
  deleteWriterPack: (id: string) =>
    request<{ ok: boolean }>(`/api/writer/packs/${id}`, { method: 'DELETE' }),

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
  listFormulas: () => request<{ formulas: FormulaSummary[] }>('/api/training/formulas'),

  // ── Formula Studio (SDD §12b) — all deterministic, no token spent ──
  listRulePool: (includeOlderVersions = false) =>
    request<{ rules: PoolRule[] }>(
      `/api/studio/rule-pool${includeOlderVersions ? '?includeOlderVersions=true' : ''}`,
    ),
  listStudioSessions: () => request<{ sessions: StudioSessionSummary[] }>('/api/studio/sessions'),
  getStudioSession: (id: string) => request<StudioSession>(`/api/studio/sessions/${encodeURIComponent(id)}`),
  createStudioSession: (genre: string) =>
    request<StudioSession>('/api/studio/sessions', { method: 'POST', body: JSON.stringify({ genre }) }),
  setStudioPicks: (id: string, picks: RuleRef[]) =>
    request<StudioSession>(`/api/studio/sessions/${encodeURIComponent(id)}/picks`, {
      method: 'POST',
      body: JSON.stringify({ picks }),
    }),
  promoteStudioCompound: (id: string) =>
    request<StudioSession>(`/api/studio/sessions/${encodeURIComponent(id)}/promote`, { method: 'POST' }),
  getFormula: (id: string) => request<Formula>(`/api/training/formulas/${encodeURIComponent(id)}`),

  startTrainingLabRun: (formulaId: string) =>
    request<TrainingLabRun>('/api/training/lab/start', {
      method: 'POST',
      body: JSON.stringify({ formulaId }),
    }),
  listTrainingLabRuns: () => request<{ runs: TrainingLabRunSummary[] }>('/api/training/lab/runs'),
  getTrainingLabRun: (id: string) =>
    request<TrainingLabRun>(`/api/training/lab/runs/${encodeURIComponent(id)}`),
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
