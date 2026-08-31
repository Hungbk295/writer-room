import { AppError } from '../errors.ts';
import { isResolvedYoutubeUcId, type SpyStore } from '../store.ts';
import {
  LOCAL_PUBLIC_WATCHLIST,
  type ChannelSummary,
  type FollowChannelResult,
  type PublicCompetitorRecord,
  type PublicWatchCadence,
  type PublicWatchStatus,
  type SavedChannelRecord,
  type StarChannelResult,
  type UnfollowChannelResult,
  type WatchlistChannelsResult,
} from './types.ts';

export interface FollowChannelInput {
  watchlistId?: string;
  note?: string;
  cadence?: PublicWatchCadence;
  watchStatus?: PublicWatchStatus;
}

function requireResolvedUcId(value: string): string {
  const youtubeUcId = value.trim();
  if (!isResolvedYoutubeUcId(youtubeUcId)) {
    throw new AppError(
      'invalid_input',
      'channel_unresolved_or_invalid: cần stable YouTube channel ID dạng UC…; hãy Spy/resolve channel trước',
    );
  }
  return youtubeUcId;
}

function nextDueAt(relation: PublicCompetitorRecord): string | null {
  if (relation.watchStatus !== 'followed' || relation.cadence !== 'daily' || !relation.lastObservedAt) return null;
  const sampled = Date.parse(relation.lastObservedAt);
  if (!Number.isFinite(sampled)) return null;
  return new Date(sampled + 24 * 60 * 60 * 1000).toISOString();
}

/**
 * C1 role service. It owns only local bookmark/follow state and accepts a
 * SpyStore, never a provider, OperationManager, scheduler, or agent port.
 */
export class SpyRoleService {
  constructor(private readonly store: SpyStore) {}

  private requireKnownChannel(youtubeUcId: string) {
    const resolved = requireResolvedUcId(youtubeUcId);
    const channel = this.store.getChannelByYoutubeUcId(resolved);
    if (!channel) {
      throw new AppError('not_found', 'channel_unknown: channel chưa có stable UC identity trong Spy; hãy Spy/resolve channel trước');
    }
    return { youtubeUcId: resolved, channel };
  }

  private requireLocalWatchlist(watchlistId = LOCAL_PUBLIC_WATCHLIST): string {
    if (watchlistId !== LOCAL_PUBLIC_WATCHLIST) {
      throw new AppError('not_found', 'watchlist không tồn tại trong local public watchlist');
    }
    return watchlistId;
  }

  /** Storage-only. No provider, operation, follow, or schedule side effect. */
  star(youtubeUcId: string, note?: string): StarChannelResult {
    const resolved = this.requireKnownChannel(youtubeUcId).youtubeUcId;
    const saved = this.store.saveChannel(resolved, note);
    return { youtubeUcId: resolved, starred: true, starredAt: saved.starredAt };
  }

  /** Storage-only and idempotent for an already resolved channel. */
  unstar(youtubeUcId: string): StarChannelResult {
    const resolved = this.requireKnownChannel(youtubeUcId).youtubeUcId;
    this.store.unsaveChannel(resolved);
    return { youtubeUcId: resolved, starred: false };
  }

  list(watchlistId = LOCAL_PUBLIC_WATCHLIST, segment: 'saved' | 'followed' = 'saved'): WatchlistChannelsResult {
    this.requireLocalWatchlist(watchlistId);
    if (segment !== 'saved' && segment !== 'followed') {
      throw new AppError('invalid_input', 'segment phải là saved hoặc followed');
    }

    const saved = new Map(this.store.listSavedChannels().map((row) => [row.youtubeUcId, row]));
    const followed = new Map(
      this.store.listPublicCompetitors(watchlistId).map((row) => [row.competitorChannelId, row]),
    );
    const ids = segment === 'saved' ? [...saved.keys()] : [...followed.keys()];
    const channels = ids
      .map((youtubeUcId) => this.toSummary(youtubeUcId, saved.get(youtubeUcId), followed.get(youtubeUcId)))
      .sort((a, b) => {
        const aDate = a.starredAt ?? '';
        const bDate = b.starredAt ?? '';
        return bDate.localeCompare(aDate) || a.youtubeUcId.localeCompare(b.youtubeUcId);
      });
    return { channels, nextCursor: null };
  }

  follow(youtubeUcId: string, input: FollowChannelInput = {}): FollowChannelResult {
    const watchlistId = this.requireLocalWatchlist(input.watchlistId);
    const resolved = this.requireKnownChannel(youtubeUcId).youtubeUcId;
    const relation = this.store.upsertPublicCompetitor({
      ownerChannelId: watchlistId,
      competitorChannelId: resolved,
      note: input.note,
      cadence: input.cadence,
      // PUT is the explicit resume/follow action; a caller can request paused
      // state in the same write when the UI needs to avoid a second round trip.
      watchStatus: input.watchStatus ?? 'followed',
    });
    return this.toFollowResult(relation);
  }

  pause(youtubeUcId: string, input: FollowChannelInput = {}): FollowChannelResult {
    const watchlistId = this.requireLocalWatchlist(input.watchlistId);
    const resolved = this.requireKnownChannel(youtubeUcId).youtubeUcId;
    const relation = this.store.updatePublicCompetitor(watchlistId, resolved, {
      note: input.note,
      cadence: input.cadence,
      watchStatus: 'paused',
    });
    return this.toFollowResult(relation);
  }

  patch(youtubeUcId: string, input: FollowChannelInput = {}): FollowChannelResult {
    const watchlistId = this.requireLocalWatchlist(input.watchlistId);
    const resolved = this.requireKnownChannel(youtubeUcId).youtubeUcId;
    const current = this.store.getPublicCompetitor(watchlistId, resolved);
    if (!current) throw new AppError('not_found', 'channel_not_followed: kênh chưa được theo dõi trong watchlist');
    const relation = this.store.updatePublicCompetitor(watchlistId, resolved, {
      note: input.note,
      cadence: input.cadence,
      watchStatus: input.watchStatus ?? current.watchStatus,
    });
    return this.toFollowResult(relation);
  }

  unfollow(youtubeUcId: string, watchlistId = LOCAL_PUBLIC_WATCHLIST): UnfollowChannelResult {
    const owner = this.requireLocalWatchlist(watchlistId);
    const resolved = this.requireKnownChannel(youtubeUcId).youtubeUcId;
    const relation = this.store.getPublicCompetitor(owner, resolved);
    if (!relation) throw new AppError('not_found', 'channel_not_followed: kênh chưa được theo dõi trong watchlist');
    this.store.removePublicCompetitor(owner, resolved);
    return { ...this.toFollowResult(relation), removed: true };
  }

  /** Additive read helper for a completed Spy run/channel workspace. */
  summary(youtubeUcId: string, watchlistId = LOCAL_PUBLIC_WATCHLIST): ChannelSummary | null {
    if (!isResolvedYoutubeUcId(youtubeUcId)) return null;
    const channel = this.store.getChannelByYoutubeUcId(youtubeUcId);
    if (!channel) return null;
    this.requireLocalWatchlist(watchlistId);
    const saved = this.store.getSavedChannel(youtubeUcId) ?? undefined;
    const relation = this.store.getPublicCompetitor(watchlistId, youtubeUcId) ?? undefined;
    return this.toSummary(youtubeUcId, saved, relation);
  }

  private toFollowResult(relation: PublicCompetitorRecord): FollowChannelResult {
    return {
      watchlistId: relation.watchlistId,
      competitorChannelId: relation.competitorChannelId,
      watchStatus: relation.watchStatus,
      cadence: relation.cadence,
      lastObservedAt: relation.lastObservedAt,
      nextDueAt: nextDueAt(relation),
    };
  }

  private toSummary(
    youtubeUcId: string,
    saved: SavedChannelRecord | undefined,
    relation: PublicCompetitorRecord | undefined,
  ): ChannelSummary {
    const channel = this.store.getChannelByYoutubeUcId(youtubeUcId);
    return {
      youtubeUcId,
      title: channel?.title ?? null,
      handle: channel?.handle ?? null,
      starred: saved !== undefined,
      starredAt: saved?.starredAt ?? null,
      watchStatus: relation?.watchStatus ?? null,
      cadence: relation?.cadence ?? null,
      lastObservedAt: relation?.lastObservedAt ?? null,
      nextDueAt: relation ? nextDueAt(relation) : null,
      note: saved?.note ?? relation?.note ?? null,
    };
  }
}

// Keep import names forgiving for callers that refer to the role boundary as
// either a singular service or a channel-role service.
export { SpyRoleService as ChannelRoleService, SpyRoleService as SpyRolesService };
