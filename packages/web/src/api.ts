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
  uptimeMs: number;
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
