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
});
