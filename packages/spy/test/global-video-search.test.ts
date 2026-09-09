import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AppError,
  SpyService,
  spyTools,
  type ChannelStatistics,
  type SearchHit,
  type SearchInput,
  type VideoStatistics,
  type YoutubePort,
  type YouTubeDataApiPort,
} from '../src/index.ts';

const roots: string[] = [];
const services: SpyService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) service.store.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function videoInfo(videoId = 'abc123def45') {
  return {
    sourceVideoId: videoId,
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    title: 'Kết quả yt-dlp',
    channelTitle: 'Kênh yt-dlp',
    channelId: 'UCytdlp',
    viewCount: 321,
    durationSec: 98,
    publishedAt: '2026-08-01',
    thumbnailUrl: null,
  };
}

function fakeYoutube(calls: Array<{ query: string; limit: number }>): YoutubePort {
  return {
    async searchVideos(query: string, limit: number) {
      calls.push({ query, limit });
      return [videoInfo()];
    },
  } as YoutubePort;
}

/** yt-dlp adapter that reports a single video with a given publishedAt (as real yt-dlp always does: null). */
function fakeYoutubeWithPublishedAt(publishedAt: string | null): YoutubePort {
  return {
    async searchVideos(_query: string, _limit: number) {
      return [{
        sourceVideoId: 'abc123def45',
        canonicalUrl: 'https://www.youtube.com/watch?v=abc123def45',
        title: 'Kết quả yt-dlp',
        channelTitle: 'Kênh yt-dlp',
        channelId: 'UCytdlp',
        viewCount: 321,
        durationSec: 98,
        publishedAt,
        thumbnailUrl: null,
      }];
    },
  } as YoutubePort;
}

class FakeDataApi implements YouTubeDataApiPort {
  searchCalls: SearchInput[] = [];
  statCalls: string[][] = [];
  searchError: Error | null = null;
  hits: SearchHit[] = [{
    kind: 'video',
    videoId: 'abc123def45',
    channelId: 'UCapi',
    title: 'Kết quả API search',
    description: null,
    channelTitle: 'Kênh API search',
    publishedAt: '2026-07-31T00:00:00Z',
    thumbnailUrl: null,
  }];

  async search(input: SearchInput) {
    this.searchCalls.push(input);
    if (this.searchError) throw this.searchError;
    return { hits: this.hits, nextPageToken: null };
  }

  async fetchVideoStatistics(videoIds: readonly string[]): Promise<Map<string, VideoStatistics>> {
    this.statCalls.push([...videoIds]);
    return new Map(videoIds.map((videoId) => [videoId, {
      videoId,
      likeCount: 4,
      commentCount: 2,
      viewCount: 4567,
      publishedAt: '2026-08-02T00:00:00Z',
      publishedAtPrecision: 'second' as const,
      durationSec: 123,
      tags: [],
      title: 'Kết quả API đầy đủ',
      channelId: 'UCapi',
      channelTitle: 'Kênh API',
      thumbnailUrl: null,
      defaultAudioLanguage: 'vi',
      defaultLanguage: 'vi',
    }]));
  }

  async fetchChannelStatistics(): Promise<Map<string, ChannelStatistics>> {
    return new Map();
  }
}

async function newService(options: { youtube: YoutubePort; dataApi?: YouTubeDataApiPort }) {
  const root = await mkdtemp(join(tmpdir(), 'wr-global-search-'));
  roots.push(root);
  const service = new SpyService({ dataRoot: join(root, 'spy'), ...options });
  services.push(service);
  await service.init();
  return service;
}

describe('globalVideoSearch', () => {
  test('uses YouTube Data API first with vi/VN defaults and returns explicit provenance', async () => {
    const ytDlpCalls: Array<{ query: string; limit: number }> = [];
    const dataApi = new FakeDataApi();
    const service = await newService({ youtube: fakeYoutube(ytDlpCalls), dataApi });

    const result = await service.globalVideoSearch({ query: 'tài chính cá nhân', limit: 12 });

    expect(dataApi.searchCalls).toEqual([{
      q: 'tài chính cá nhân',
      type: 'video',
      order: 'relevance',
      maxResults: 12,
      relevanceLanguage: 'vi',
      regionCode: 'VN',
    }]);
    expect(dataApi.statCalls).toEqual([['abc123def45']]);
    expect(ytDlpCalls).toEqual([]);
    expect(result).toEqual({
      query: 'tài chính cá nhân',
      limit: 12,
      language: 'vi',
      region: 'VN',
      providerUsed: 'youtube_data_api',
      localeHintsApplied: true,
      fallbackReason: null,
      cache: { status: 'miss', ageSeconds: null },
      videos: [{
        videoId: 'abc123def45',
        title: 'Kết quả API đầy đủ',
        channelTitle: 'Kênh API',
        canonicalUrl: 'https://www.youtube.com/watch?v=abc123def45',
        viewCount: 4567,
        durationSec: 123,
        publishedAt: '2026-08-02T00:00:00Z',
      }],
    });
  });

  test('falls back to yt-dlp when no API key is configured', async () => {
    const ytDlpCalls: Array<{ query: string; limit: number }> = [];
    const service = await newService({ youtube: fakeYoutube(ytDlpCalls) });

    const result = await service.globalVideoSearch({ query: 'kể chuyện việt nam' });

    expect(ytDlpCalls).toEqual([{ query: 'kể chuyện việt nam', limit: 20 }]);
    expect(result).toMatchObject({
      providerUsed: 'ytdlp',
      localeHintsApplied: false,
      fallbackReason: 'youtube_data_api_not_configured',
      language: 'vi',
      region: 'VN',
      videos: [{
        videoId: 'abc123def45',
        title: 'Kết quả yt-dlp',
        channelTitle: 'Kênh yt-dlp',
        canonicalUrl: 'https://www.youtube.com/watch?v=abc123def45',
        viewCount: 321,
        durationSec: 98,
        publishedAt: '2026-08-01',
      }],
    });
  });

  test('falls back to yt-dlp when the Data API provider fails', async () => {
    const ytDlpCalls: Array<{ query: string; limit: number }> = [];
    const dataApi = new FakeDataApi();
    dataApi.searchError = new AppError('provider_error', 'YouTube Data API 503', { retryable: true });
    const service = await newService({ youtube: fakeYoutube(ytDlpCalls), dataApi });

    const result = await service.globalVideoSearch({ query: 'kinh doanh', language: 'en', region: 'us' });

    expect(dataApi.searchCalls).toHaveLength(1);
    expect(dataApi.statCalls).toEqual([]);
    expect(ytDlpCalls).toEqual([{ query: 'kinh doanh', limit: 20 }]);
    expect(result).toMatchObject({
      providerUsed: 'ytdlp',
      localeHintsApplied: false,
      fallbackReason: 'youtube_data_api_provider_error',
      language: 'en',
      region: 'US',
    });
  });

  test('rejects invalid tool input before either provider is called', async () => {
    const ytDlpCalls: Array<{ query: string; limit: number }> = [];
    const dataApi = new FakeDataApi();
    const service = await newService({ youtube: fakeYoutube(ytDlpCalls), dataApi });
    const tool = spyTools(service).find((candidate) => candidate.name === 'spy_global_video_search');
    expect(tool).toBeDefined();
    const context = { subject: 'test-agent', scopes: new Set(['spy.start']) };

    await expect(tool!.handler({ query: '   ' }, context)).rejects.toThrow(/query|string/);
    await expect(tool!.handler({ query: 'ok', limit: 0 }, context)).rejects.toThrow(/1\.\.50/);
    await expect(tool!.handler({ query: 'ok', language: 'vietnamese' }, context)).rejects.toThrow(/ISO 639-1/);

    expect(dataApi.searchCalls).toEqual([]);
    expect(dataApi.statCalls).toEqual([]);
    expect(ytDlpCalls).toEqual([]);
  });

  test('rejects invalid refresh/max_age_hours before either provider is called', async () => {
    const ytDlpCalls: Array<{ query: string; limit: number }> = [];
    const dataApi = new FakeDataApi();
    const service = await newService({ youtube: fakeYoutube(ytDlpCalls), dataApi });

    await expect(service.globalVideoSearch({ query: 'ok', refresh: 'sometimes' as never }))
      .rejects.toThrow(/refresh/);
    await expect(service.globalVideoSearch({ query: 'ok', maxAgeHours: 0 }))
      .rejects.toThrow(/max_age_hours/);
    await expect(service.globalVideoSearch({ query: 'ok', maxAgeHours: -5 }))
      .rejects.toThrow(/max_age_hours/);

    expect(dataApi.searchCalls).toEqual([]);
    expect(ytDlpCalls).toEqual([]);
  });

  describe('cache', () => {
    test('repeating the same query serves from cache and never calls the provider again', async () => {
      const ytDlpCalls: Array<{ query: string; limit: number }> = [];
      const dataApi = new FakeDataApi();
      const service = await newService({ youtube: fakeYoutube(ytDlpCalls), dataApi });

      const first = await service.globalVideoSearch({ query: 'tài chính cá nhân', limit: 5 });
      expect(first.cache).toEqual({ status: 'miss', ageSeconds: null });
      expect(dataApi.searchCalls).toHaveLength(1);
      expect(dataApi.statCalls).toHaveLength(1);

      // Query text differs only by casing/whitespace — must still hit cache.
      const second = await service.globalVideoSearch({ query: '  Tài Chính Cá Nhân  ', limit: 5 });
      expect(dataApi.searchCalls).toHaveLength(1);
      expect(dataApi.statCalls).toHaveLength(1);
      expect(second.cache.status).toBe('hit');
      expect(second.cache.ageSeconds).toBeGreaterThanOrEqual(0);
      expect(second.videos).toEqual(first.videos);
      expect(second.providerUsed).toBe('youtube_data_api');
    });

    test('a smaller cached limit does not satisfy a larger request (insufficient_limit refetch)', async () => {
      const ytDlpCalls: Array<{ query: string; limit: number }> = [];
      const dataApi = new FakeDataApi();
      const service = await newService({ youtube: fakeYoutube(ytDlpCalls), dataApi });

      await service.globalVideoSearch({ query: 'kể chuyện', limit: 1 });
      expect(dataApi.searchCalls).toHaveLength(1);

      const second = await service.globalVideoSearch({ query: 'kể chuyện', limit: 10 });
      expect(dataApi.searchCalls).toHaveLength(2);
      expect(second.cache.status).toBe('insufficient_limit');
    });

    test('refresh: always bypasses cache even immediately after a hit would apply', async () => {
      const ytDlpCalls: Array<{ query: string; limit: number }> = [];
      const dataApi = new FakeDataApi();
      const service = await newService({ youtube: fakeYoutube(ytDlpCalls), dataApi });

      await service.globalVideoSearch({ query: 'đầu tư', limit: 3 });
      const second = await service.globalVideoSearch({ query: 'đầu tư', limit: 3, refresh: 'always' });
      expect(dataApi.searchCalls).toHaveLength(2);
      expect(second.cache.status).toBe('forced');
    });

    test('refresh: if_stale refetches once max_age_hours has elapsed, refresh: never does not', async () => {
      const ytDlpCalls: Array<{ query: string; limit: number }> = [];
      const dataApi = new FakeDataApi();
      const service = await newService({ youtube: fakeYoutube(ytDlpCalls), dataApi });

      await service.globalVideoSearch({ query: 'chứng khoán', limit: 3 });
      // Backdate the cache row far into the past instead of sleeping in the test.
      const stale = service.store.getSearchQueryCache('chứng khoán', 'vi', 'VN', 'youtube_data_api')!;
      service.store.upsertSearchQueryCache({ ...stale, fetchedAt: '2000-01-01T00:00:00.000Z' });

      const neverResult = await service.globalVideoSearch({
        query: 'chứng khoán', limit: 3, refresh: 'never', maxAgeHours: 1,
      });
      expect(dataApi.searchCalls).toHaveLength(1); // still just the first live call
      expect(neverResult.cache.status).toBe('hit');
      expect(neverResult.cache.ageSeconds).toBeGreaterThan(1000);

      const staleResult = await service.globalVideoSearch({
        query: 'chứng khoán', limit: 3, refresh: 'if_stale', maxAgeHours: 1,
      });
      expect(dataApi.searchCalls).toHaveLength(2);
      expect(staleResult.cache.status).toBe('stale');
    });

    test('a fresh cached video is not re-fetched from videos.list even under a brand-new query', async () => {
      const ytDlpCalls: Array<{ query: string; limit: number }> = [];
      const dataApi = new FakeDataApi();
      const service = await newService({ youtube: fakeYoutube(ytDlpCalls), dataApi });

      await service.globalVideoSearch({ query: 'quản lý tiền', limit: 3 });
      expect(dataApi.statCalls).toEqual([['abc123def45']]);

      // Different query, same underlying video (FakeDataApi always returns the
      // same hit) — the per-video stats cache should skip fetchVideoStatistics.
      await service.globalVideoSearch({ query: 'tiết kiệm tiền', limit: 3 });
      expect(dataApi.statCalls).toEqual([['abc123def45']]); // unchanged — no second call
    });

    test('yt-dlp fallback (publishedAt: null on every result) never overwrites an already-known date', async () => {
      // Real yt-dlp adapter reports publishedAt: null on every result — a
      // naive cache write would treat that null as "confirmed no date" and
      // erase a date we already learned from the Data API.
      const service = await newService({ youtube: fakeYoutubeWithPublishedAt(null) });

      const first = await service.globalVideoSearch({ query: 'kể chuyện việt nam' });
      expect(first.providerUsed).toBe('ytdlp');
      expect(first.videos[0]!.publishedAt).toBeNull();
      const afterYtdlp = service.store.getSearchVideoCacheRows(['abc123def45']).get('abc123def45')!;
      expect(afterYtdlp.publishedAt).toBeNull();
      expect(afterYtdlp.publishedAtKnown).toBe(false);

      // A later write that DOES know the date (as if a Data API fetch had
      // supplied it) must be able to set it...
      service.store.upsertSearchVideoCache({
        ...afterYtdlp,
        publishedAt: '2026-07-31T00:00:00Z',
        publishedAtKnown: true,
        providerUsed: 'youtube_data_api',
        fetchedAt: new Date().toISOString(),
      });
      const known = service.store.getSearchVideoCacheRows(['abc123def45']).get('abc123def45')!;
      expect(known.publishedAt).toBe('2026-07-31T00:00:00Z');
      expect(known.publishedAtKnown).toBe(true);

      // ...and a subsequent unknown (yt-dlp) write must not erase it.
      service.store.upsertSearchVideoCache({
        ...known,
        publishedAt: null,
        publishedAtKnown: false,
        providerUsed: 'ytdlp',
        fetchedAt: new Date().toISOString(),
      });
      const merged = service.store.getSearchVideoCacheRows(['abc123def45']).get('abc123def45')!;
      expect(merged.publishedAt).toBe('2026-07-31T00:00:00Z');
      expect(merged.publishedAtKnown).toBe(true);
    });
  });
});
