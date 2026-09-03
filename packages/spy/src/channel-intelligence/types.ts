/** C1 public channel roles. Observation/VPH models intentionally do not live here. */

export const LOCAL_PUBLIC_WATCHLIST = 'local-desktop';

export type PublicWatchStatus = 'followed' | 'paused';
export type PublicWatchCadence = 'daily' | 'manual';

export interface SavedChannelRecord {
  youtubeUcId: string;
  starredAt: string;
  note: string | null;
  updatedAt: string;
}

export interface PublicCompetitorRecord {
  id: string;
  watchlistId: string;
  competitorChannelId: string;
  note: string | null;
  watchStatus: PublicWatchStatus;
  cadence: PublicWatchCadence;
  lastObservedAt: string | null;
  lastObservationStatus: string | null;
  createdAt: string;
}

/** Shared UI/API read model. Keep these names stable for the web client. */
export interface ChannelSummary {
  youtubeUcId: string;
  title: string | null;
  handle: string | null;
  starred: boolean;
  starredAt: string | null;
  watchStatus: PublicWatchStatus | null;
  cadence: PublicWatchCadence | null;
  lastObservedAt: string | null;
  lastObservationStatus: PublicObservationStatus | null;
  lastObservationCompleteness: PublicObservationCompleteness | null;
  comparableVph24hCount: number | null;
  medianVph24h: number | null;
  nextDueAt: string | null;
  note: string | null;
}

export interface WatchlistChannelsResult {
  channels: ChannelSummary[];
  nextCursor: string | null;
}

export interface StarChannelResult {
  youtubeUcId: string;
  starred: boolean;
  starredAt?: string;
}

export interface FollowChannelResult {
  watchlistId: string;
  competitorChannelId: string;
  watchStatus: PublicWatchStatus;
  cadence: PublicWatchCadence;
  lastObservedAt: string | null;
  nextDueAt: string | null;
}

export interface UnfollowChannelResult extends FollowChannelResult {
  removed: true;
}

// ── C3 public observation + VPH ────────────────────────────────────────────

export type PublicObservationStatus = 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'unavailable';
export type PublicObservationCompleteness = 'complete' | 'partial' | 'unavailable';
export type PublicObservationPlanKind = 'daily' | 'manual';
export type PublicVideoAvailability = 'present' | 'missing' | 'private' | 'error';
export type PublicViewQuality = 'known' | 'unknown' | 'decreased_vs_prior';

export interface PublicObservationRun {
  id: string;
  watchlistId: string;
  competitorChannelId: string;
  planKind: PublicObservationPlanKind;
  planVersion: string;
  localDate: string;
  providerUsed: 'ytdlp';
  status: PublicObservationStatus;
  completeness: PublicObservationCompleteness;
  startedAt: string;
  completedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  playlistLimit: number;
  inspectAttempted: number;
  inspectOk: number;
}

export interface PublicVideoStatPoint {
  id: string;
  observationRunId: string;
  sourceVideoId: string;
  youtubeUcId: string | null;
  sampledAt: string;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  durationSec: number | null;
  publishedAt: string | null;
  title: string | null;
  availability: PublicVideoAvailability;
  viewQuality: PublicViewQuality;
  providerUsed: 'ytdlp';
  inspectUsed: boolean;
  createdAt: string;
}

export type PublicVphWindow = '1h' | '24h' | '7d';
export type VphComparability = 'comparable_1h' | 'comparable_24h' | 'comparable_7d' | 'not_comparable_to_1h' | 'not_comparable_to_24h' | 'not_comparable_to_7d' | 'stretched' | 'coverage_daily_only' | 'insufficient_sample' | 'unavailable';

export interface PublicVphQuery {
  window?: PublicVphWindow;
  from?: string | null;
  to?: string | null;
  ageBucket?: string | null;
  durationBucket?: string | null;
  publishedWeekday?: number | null;
  includeNonComparable?: boolean;
  cursor?: string | null;
  /** Configuration timezone, supplied by the daemon boundary for labels. */
  timezone?: string;
  /** Capped read size. A truncated response is explicit in coverage. */
  limit?: number;
}

export interface PublicVphSegment {
  sourceVideoId: string;
  title: string | null;
  publishedAt: string | null;
  durationSec: number | null;
  requestedWindow: PublicVphWindow;
  actualElapsedHours: number | null;
  value: number | null;
  method: 'deterministic' | 'insufficient_sample' | 'unavailable';
  comparability: VphComparability;
  reason?: string;
  start: { sampledAt: string; viewCount: number } | null;
  end: { sampledAt: string; viewCount: number } | null;
  /** Current raw state, always visible even when VPH itself is unavailable. */
  availability: PublicVideoAvailability | null;
  viewQuality: PublicViewQuality | null;
  inspectUsed: boolean | null;
  providerUsed: 'ytdlp';
  definitionVersion: 'vph/v1';
}

export interface PublicVphVideo {
  sourceVideoId: string;
  title: string | null;
  publishedAt: string | null;
  durationSec: number | null;
  latestSampledAt: string | null;
  latestViewCount: number | null;
  availability: PublicVideoAvailability | null;
  viewQuality: PublicViewQuality | null;
  inspectUsed: boolean | null;
}

export interface PublicVphProvenance {
  visibility: 'public';
  providerUsed: 'ytdlp';
  dataApiUsed: false;
  definitionVersion: 'vph/v1';
}

export interface PublicVphCoverage {
  rawPointCount: number;
  videoCount: number;
  latestRunStatus: PublicObservationStatus | null;
  latestRunCompleteness: PublicObservationCompleteness | null;
  latestRunAt: string | null;
  inspectedVideoCount: number;
  unavailablePointCount: number;
  truncated: boolean;
  nextCursor: string | null;
}

export interface PublicVphAggregations {
  medianVph: number | null;
  comparableCount: number;
  measuredCount: number;
  unavailableCount: number;
  cohorts: Array<{
    ageBucket: '0-48h' | '2-7d' | '7-30d';
    sampleCount: number;
    medianVph: number | null;
    p25: number | null;
    p75: number | null;
    reason?: 'insufficient_sample';
  }>;
}

export interface PublicVideoVphRead {
  sourceVideoId: string;
  youtubeUcId: string;
  requestedWindow: PublicVphWindow;
  definitionVersion: 'vph/v1';
  timezone: string;
  provenance: PublicVphProvenance;
  coverage: Pick<PublicVphCoverage, 'rawPointCount' | 'truncated' | 'nextCursor' | 'unavailablePointCount'>;
  rawPoints: PublicVideoStatPoint[];
  vphSegments: PublicVphSegment[];
}

export interface PublicChannelVphRead {
  youtubeUcId: string;
  requestedWindow: PublicVphWindow;
  definitionVersion: 'vph/v1';
  timezone: string;
  observedAt: string | null;
  provenance: PublicVphProvenance;
  coverage: PublicVphCoverage;
  videos: PublicVphVideo[];
  vphSegments: PublicVphSegment[];
  /** Consecutive historical segments, used by the 14-day heatmap/drilldown. */
  vphTimeline: PublicVphSegment[];
  aggregations: PublicVphAggregations;
  /** Legacy aliases retained for the first C3 UI slice. */
  segments: PublicVphSegment[];
  medianVph24h: number | null;
  comparableCount: number;
  notes: string[];
}
