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
