import { AppError } from '../errors.ts';


export function youtubeThumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

function pickThumbnail(item: ApiItem, videoId: string): string {
  const thumbs = item.snippet?.thumbnails;
  return thumbs?.high?.url
    ?? thumbs?.medium?.url
    ?? thumbs?.standard?.url
    ?? thumbs?.default?.url
    ?? youtubeThumbnailUrl(videoId);
}

/** Parse YouTube ISO-8601 duration (e.g. PT1H2M3S → 3723). */
export function parseIso8601Duration(value: string | undefined | null): number | null {
  if (!value || typeof value !== 'string') return null;
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  if (![hours, minutes, seconds].every(Number.isFinite)) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

export interface VideoStatistics {
  videoId: string;
  likeCount: number | null;
  commentCount: number | null;
  viewCount: number | null;
  publishedAt: string | null;
  publishedAtPrecision: 'second' | 'day' | null;
  durationSec: number | null;
  tags: string[];
  title: string | null;
  channelId: string | null;
  channelTitle: string | null;
  thumbnailUrl: string | null;
}

export interface ChannelStatistics {
  channelId: string;
  title: string | null;
  subscriberCount: number | null;
  videoCount: number | null;
  viewCount: number | null;
  uploadsPlaylistId: string | null;
}

export interface PlaylistVideoItem {
  videoId: string;
  publishedAt: string | null;
  title: string | null;
  position: number;
}

export interface CommentThread {
  commentId: string;
  videoId: string | null;
  authorDisplayName: string | null;
  text: string;
  likeCount: number | null;
  publishedAt: string | null;
  updatedAt: string | null;
  totalReplyCount: number;
  replies: Array<{
    commentId: string;
    authorDisplayName: string | null;
    text: string;
    likeCount: number | null;
    publishedAt: string | null;
  }>;
}

export interface YouTubeDataApiPort {
  fetchVideoStatistics(videoIds: readonly string[]): Promise<Map<string, VideoStatistics>>;
  fetchChannelStatistics(channelIds: readonly string[]): Promise<Map<string, ChannelStatistics>>;
  resolveChannelByHandle?(handle: string): Promise<ChannelStatistics | null>;
  fetchVideoComments?(input: {
    videoId?: string;
    channelId?: string;
    maxResults?: number;
    order?: 'relevance' | 'time';
    includeReplies?: boolean;
  }): Promise<CommentThread[]>;
  listUploadsPlaylistItems?(
    uploadsPlaylistId: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<PlaylistVideoItem[]>;
}

interface ApiItem {
  id?: string | { channelId?: string; playlistId?: string; videoId?: string };
  snippet?: {
    title?: string;
    publishedAt?: string;
    tags?: string[];
    channelId?: string;
    channelTitle?: string;
    resourceId?: { videoId?: string };
    position?: number;
    thumbnails?: {
      default?: { url?: string };
      medium?: { url?: string };
      high?: { url?: string };
      standard?: { url?: string };
      maxres?: { url?: string };
    };
  };
  contentDetails?: {
    relatedPlaylists?: { uploads?: string };
    duration?: string;
    videoId?: string;
  };
  statistics?: {
    likeCount?: string;
    commentCount?: string;
    viewCount?: string;
    subscriberCount?: string;
    videoCount?: string;
  };
}

interface ListResponse {
  items?: ApiItem[];
  nextPageToken?: string;
}

interface CommentSnippet {
  authorDisplayName?: string;
  textOriginal?: string;
  textDisplay?: string;
  likeCount?: number;
  publishedAt?: string;
  updatedAt?: string;
}

interface CommentResource {
  id?: string;
  snippet?: CommentSnippet;
}

interface CommentThreadListResponse {
  items?: Array<{
    snippet?: {
      videoId?: string;
      totalReplyCount?: number;
      topLevelComment?: CommentResource;
    };
    replies?: { comments?: CommentResource[] };
  }>;
  nextPageToken?: string;
}

function parseCount(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asStringId(id: ApiItem['id']): string | null {
  if (typeof id === 'string') return id;
  if (id && typeof id === 'object' && typeof id.channelId === 'string') return id.channelId;
  return null;
}

export class YouTubeDataApiAdapter implements YouTubeDataApiPort {
  private apiKey?: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey;
  }

  setApiKey(apiKey?: string): void {
    this.apiKey = apiKey;
  }

  private enabled(): boolean {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  private async fetch(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<ListResponse> {
    if (!this.enabled()) return { items: [] };
    const url = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
    url.searchParams.set('key', this.apiKey!);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await fetch(url, { signal });
    if (!response.ok) {
      throw new AppError('provider_error', `YouTube Data API ${response.status}`, {
        retryable: response.status >= 500 || response.status === 429,
      });
    }
    return await response.json() as ListResponse;
  }

  async fetchVideoStatistics(videoIds: readonly string[]): Promise<Map<string, VideoStatistics>> {
    const result = new Map<string, VideoStatistics>();
    if (!this.enabled() || videoIds.length === 0) return result;
    for (let offset = 0; offset < videoIds.length; offset += 50) {
      const batch = videoIds.slice(offset, offset + 50);
      const payload = await this.fetch('videos', {
        part: 'statistics,snippet,contentDetails',
        id: batch.join(','),
      });
      for (const item of payload.items ?? []) {
        if (!item.id || typeof item.id !== 'string') continue;
        result.set(item.id, {
          videoId: item.id,
          likeCount: parseCount(item.statistics?.likeCount),
          commentCount: parseCount(item.statistics?.commentCount),
          viewCount: parseCount(item.statistics?.viewCount),
          publishedAt: item.snippet?.publishedAt ?? null,
          publishedAtPrecision: item.snippet?.publishedAt ? 'second' : null,
          durationSec: parseIso8601Duration(item.contentDetails?.duration),
          tags: item.snippet?.tags ?? [],
          title: item.snippet?.title ?? null,
          channelId: item.snippet?.channelId ?? null,
          channelTitle: item.snippet?.channelTitle ?? null,
          thumbnailUrl: pickThumbnail(item, item.id),
        });
      }
    }
    return result;
  }

  async fetchChannelStatistics(channelIds: readonly string[]): Promise<Map<string, ChannelStatistics>> {
    const result = new Map<string, ChannelStatistics>();
    if (!this.enabled() || channelIds.length === 0) return result;
    for (let offset = 0; offset < channelIds.length; offset += 50) {
      const batch = channelIds.slice(offset, offset + 50);
      const payload = await this.fetch('channels', {
        part: 'statistics,snippet,contentDetails',
        id: batch.join(','),
      });
      for (const item of payload.items ?? []) {
        const id = asStringId(item.id);
        if (!id) continue;
        result.set(id, {
          channelId: id,
          title: item.snippet?.title ?? null,
          subscriberCount: parseCount(item.statistics?.subscriberCount),
          videoCount: parseCount(item.statistics?.videoCount),
          viewCount: parseCount(item.statistics?.viewCount),
          uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads ?? null,
        });
      }
    }
    return result;
  }

  async resolveChannelByHandle(handle: string): Promise<ChannelStatistics | null> {
    if (!this.enabled()) return null;
    const cleaned = handle.replace(/^@/, '').trim();
    if (!cleaned) return null;
    const payload = await this.fetch('channels', {
      part: 'statistics,snippet,contentDetails',
      forHandle: cleaned,
    });
    const item = payload.items?.[0];
    if (!item) return null;
    const id = asStringId(item.id);
    if (!id) return null;
    return {
      channelId: id,
      title: item.snippet?.title ?? null,
      subscriberCount: parseCount(item.statistics?.subscriberCount),
      videoCount: parseCount(item.statistics?.videoCount),
      viewCount: parseCount(item.statistics?.viewCount),
      uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads ?? null,
    };
  }

  /**
   * commentThreads.list — 1 quota unit/call, tối đa 100 thread/call.
   * Truyền videoId HOẶC channelId (channelId = comment trên mọi video của kênh).
   */
  async fetchVideoComments(input: {
    videoId?: string;
    channelId?: string;
    maxResults?: number;
    order?: 'relevance' | 'time';
    includeReplies?: boolean;
  }): Promise<CommentThread[]> {
    if (!this.enabled()) {
      throw new AppError('capability_missing', 'Chưa cấu hình youtubeDataApiKey — không lấy được comment');
    }
    if (!input.videoId && !input.channelId) {
      throw new AppError('invalid_input', 'Cần videoId hoặc channelId');
    }
    if (input.videoId && input.channelId) {
      throw new AppError('invalid_input', 'Chỉ truyền một trong videoId / channelId');
    }
    const wanted = Math.max(1, Math.min(input.maxResults ?? 20, 100));
    const includeReplies = input.includeReplies !== false;
    const params: Record<string, string> = {
      part: includeReplies ? 'snippet,replies' : 'snippet',
      maxResults: String(wanted),
      order: input.order === 'time' ? 'time' : 'relevance',
      textFormat: 'plainText',
    };
    if (input.videoId) params['videoId'] = input.videoId;
    if (input.channelId) params['allThreadsRelatedToChannelId'] = input.channelId;

    const payload = await this.fetch('commentThreads', params) as unknown as CommentThreadListResponse;
    const threads: CommentThread[] = [];
    for (const item of payload.items ?? []) {
      const top = item.snippet?.topLevelComment;
      const snippet = top?.snippet;
      if (!top?.id || !snippet) continue;
      threads.push({
        commentId: top.id,
        videoId: item.snippet?.videoId ?? input.videoId ?? null,
        authorDisplayName: snippet.authorDisplayName ?? null,
        text: snippet.textOriginal ?? snippet.textDisplay ?? '',
        likeCount: parseCount(snippet.likeCount === undefined ? undefined : String(snippet.likeCount)),
        publishedAt: snippet.publishedAt ?? null,
        updatedAt: snippet.updatedAt ?? null,
        totalReplyCount: Number(item.snippet?.totalReplyCount ?? 0),
        replies: (item.replies?.comments ?? [])
          .filter((reply) => Boolean(reply.id && reply.snippet))
          .map((reply) => ({
            commentId: reply.id!,
            authorDisplayName: reply.snippet?.authorDisplayName ?? null,
            text: reply.snippet?.textOriginal ?? reply.snippet?.textDisplay ?? '',
            likeCount: parseCount(
              reply.snippet?.likeCount === undefined ? undefined : String(reply.snippet.likeCount),
            ),
            publishedAt: reply.snippet?.publishedAt ?? null,
          })),
      });
    }
    return threads;
  }

  async listUploadsPlaylistItems(
    uploadsPlaylistId: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<PlaylistVideoItem[]> {
    if (!this.enabled() || limit <= 0) return [];
    const items: PlaylistVideoItem[] = [];
    let pageToken: string | undefined;
    while (items.length < limit) {
      const pageSize = Math.min(50, limit - items.length);
      const params: Record<string, string> = {
        part: 'contentDetails,snippet',
        playlistId: uploadsPlaylistId,
        maxResults: String(pageSize),
      };
      if (pageToken) params['pageToken'] = pageToken;
      const payload = await this.fetch('playlistItems', params, signal);
      for (const item of payload.items ?? []) {
        const videoId = item.contentDetails?.videoId
          ?? item.snippet?.resourceId?.videoId
          ?? null;
        if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) continue;
        items.push({
          videoId,
          publishedAt: item.contentDetails
            ? (item.snippet?.publishedAt ?? null)
            : (item.snippet?.publishedAt ?? null),
          title: item.snippet?.title ?? null,
          position: item.snippet?.position ?? items.length,
        });
        if (items.length >= limit) break;
      }
      pageToken = payload.nextPageToken;
      if (!pageToken) break;
    }
    return items;
  }
}
