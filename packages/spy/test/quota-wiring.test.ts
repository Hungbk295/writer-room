/**
 * quota-wiring.test.ts — sổ quota có ĐÚNG MỘT chủ: QuotaCountingDataApi.
 *
 * Ba lỗi mà file này khoá lại, cả ba đều từng tồn tại cùng lúc:
 *   1. `videosByIds`/`channelsByIds`/`videoComments` gọi adapter THÔ → ghi sổ 0 unit
 *      trong khi vẫn đốt quota thật của Google (hardgate G1).
 *   2. `DiscoveryService` vừa tự `quota.consume` vừa nhận adapter đã bọc →
 *      production ghi 2 unit cho 1 search, test ghi 1 (vì test inject adapter thô).
 *   3. Decorator ghi sổ TRƯỚC khi biết inner có hỗ trợ call hay không → ghi cho
 *      một request không bao giờ được gửi.
 *
 * Vì adapter inject từ test giờ CŨNG được bọc, các con số dưới đây chính là con số
 * production. Đó là điểm của bài test: không còn đường riêng cho test nữa.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpyService } from '../src/index.ts';
import { SpyStore } from '../src/store.ts';
import { QuotaLedger, quotaDayOf, isSameQuotaDay } from '../src/quota.ts';
import { QuotaCountingDataApi } from '../src/adapters/quota-counting-data-api.ts';
import { AppError } from '../src/errors.ts';
import type {
  ChannelStatistics,
  CommentThread,
  PlaylistVideoItem,
  SearchHit,
  SearchInput,
  VideoStatistics,
  YouTubeDataApiPort,
} from '../src/adapters/data-api.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Adapter đầy đủ năng lực — đếm số call thật sự gửi đi. */
class FullFakeApi implements YouTubeDataApiPort {
  videoStatCalls = 0;
  channelStatCalls = 0;
  searchCalls = 0;
  commentCalls = 0;
  featuredCalls = 0;
  playlistCalls = 0;
  /** Bật để giả lập transport chết SAU khi request đã khởi phát. */
  failTransport = false;

  private maybeFail(): void {
    if (this.failTransport) throw new AppError('provider_error', 'YouTube Data API 503');
  }

  async fetchVideoStatistics(videoIds: readonly string[]): Promise<Map<string, VideoStatistics>> {
    this.videoStatCalls++;
    this.maybeFail();
    const map = new Map<string, VideoStatistics>();
    for (const videoId of videoIds) {
      map.set(videoId, {
        videoId, likeCount: 1, commentCount: 1, viewCount: 100,
        publishedAt: '2026-01-01T00:00:00Z', publishedAtPrecision: 'second',
        durationSec: 60, tags: [], title: `Video ${videoId}`,
        channelId: 'UCfake', channelTitle: 'Fake', thumbnailUrl: null,
        defaultAudioLanguage: null, defaultLanguage: null,
      });
    }
    return map;
  }

  async fetchChannelStatistics(channelIds: readonly string[]): Promise<Map<string, ChannelStatistics>> {
    this.channelStatCalls++;
    this.maybeFail();
    const map = new Map<string, ChannelStatistics>();
    for (const channelId of channelIds) {
      map.set(channelId, {
        channelId, title: `Kênh ${channelId}`, description: null,
        subscriberCount: 1000, videoCount: 10, viewCount: 5000,
        uploadsPlaylistId: `UU${channelId.slice(2)}`,
        publishedAt: '2024-01-01T00:00:00Z', country: 'VN',
      });
    }
    return map;
  }

  async search(_input: SearchInput): Promise<{ hits: SearchHit[]; nextPageToken: string | null }> {
    this.searchCalls++;
    this.maybeFail();
    return { hits: [] as SearchHit[], nextPageToken: null };
  }

  async fetchVideoComments(): Promise<CommentThread[]> {
    this.commentCalls++;
    this.maybeFail();
    return [];
  }

  async fetchFeaturedChannels(): Promise<string[]> {
    this.featuredCalls++;
    this.maybeFail();
    return [];
  }

  async listUploadsPlaylistItems(): Promise<PlaylistVideoItem[]> {
    this.playlistCalls++;
    this.maybeFail();
    return [];
  }
}

/** Adapter tối thiểu — chỉ có 2 method bắt buộc của port. */
class MinimalFakeApi implements YouTubeDataApiPort {
  async fetchVideoStatistics(): Promise<Map<string, VideoStatistics>> { return new Map(); }
  async fetchChannelStatistics(): Promise<Map<string, ChannelStatistics>> { return new Map(); }
}

async function newSpy(dataApi: YouTubeDataApiPort) {
  const root = await mkdtemp(join(tmpdir(), 'spy-quota-'));
  roots.push(root);
  const spy = new SpyService({ dataRoot: join(root, 'spy'), dataApi });
  await spy.init();
  return spy;
}

function freshLedger(): { store: SpyStore; quota: QuotaLedger; dispose: () => void } {
  const path = join(tmpdir(), `spy-ledger-${Math.random().toString(36).slice(2)}.sqlite`);
  const store = new SpyStore(path);
  return { store, quota: new QuotaLedger(store), dispose: () => store.close() };
}

// ---------------------------------------------------------------------------
// G1 — by-ids và comments phải ghi sổ
// ---------------------------------------------------------------------------

describe('SpyService — endpoint tra cứu trực tiếp ghi sổ quota (G1)', () => {
  test('videosByIds ghi 1 unit videos.list', async () => {
    const api = new FullFakeApi();
    const spy = await newSpy(api);
    const before = spy.quota.remaining('general');
    await spy.videosByIds(['vid1', 'vid2']);
    expect(api.videoStatCalls).toBe(1);
    expect(before - spy.quota.remaining('general')).toBe(1);
  });

  test('channelsByIds ghi 1 unit channels.list', async () => {
    const api = new FullFakeApi();
    const spy = await newSpy(api);
    const before = spy.quota.remaining('general');
    await spy.channelsByIds(['UCaaaaaaaaaaaaaaaaaaaaaa']);
    expect(api.channelStatCalls).toBe(1);
    expect(before - spy.quota.remaining('general')).toBe(1);
  });

  test('videoComments ghi 1 unit commentThreads.list', async () => {
    const api = new FullFakeApi();
    const spy = await newSpy(api);
    const before = spy.quota.remaining('general');
    await spy.videoComments({ videoId: 'vid1' });
    expect(api.commentCalls).toBe(1);
    expect(before - spy.quota.remaining('general')).toBe(1);
  });

  test('51 video = 2 lô = 2 unit', async () => {
    const api = new FullFakeApi();
    const spy = await newSpy(api);
    const before = spy.quota.remaining('general');
    await spy.videosByIds(Array.from({ length: 50 }, (_, i) => `v${i}`));
    expect(before - spy.quota.remaining('general')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Không còn double-count: decorator là chủ sổ duy nhất
// ---------------------------------------------------------------------------

describe('DiscoveryService — 1 call = 1 unit, không nhân đôi', () => {
  test('discoverVideos ghi ĐÚNG 1 search.list (trước đây 2 trong production)', async () => {
    const api = new FullFakeApi();
    const spy = await newSpy(api);
    await spy.setNiche({
      version: 1,
      markets: [{ id: 'vi', label: 'VN', relevanceLanguage: 'vi', regionCode: 'VN', seedKeywords: ['tài chính'] }],
      negativeKeywords: [],
      format: { videoDuration: 'any', minDurationSec: 0, maxDurationSec: 0 },
      channelFilter: { minSubscribers: 0, maxSubscribers: 0, minVideos: 0 },
      excludeChannelIds: [],
      scoring: { keywordOverlap: 40, subscriberBand: 20, uploadRecency: 15, avgViewsPerVideo: 15, languageMatch: 10 },
      notes: '',
    });

    const before = spy.quota.remaining('search');
    await spy.discoverVideos({ query: 'lãi kép', marketId: 'vi' });
    expect(api.searchCalls).toBe(1);
    expect(before - spy.quota.remaining('search')).toBe(1);
  });

  test('expandGraph ghi 1 channelSections.list/kênh gốc, không nhân đôi', async () => {
    const api = new FullFakeApi();
    const spy = await newSpy(api);
    const before = spy.quota.remaining('general');
    await spy.expandGraph({ channelIds: ['UCseed0000000000000000000'] });
    expect(api.featuredCalls).toBe(1);
    // 1 channelSections; không có kênh mới nên không có channels.list enrich.
    expect(before - spy.quota.remaining('general')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Thời điểm ghi sổ
// ---------------------------------------------------------------------------

describe('QuotaCountingDataApi — ghi sổ đúng thời điểm, đúng một lần', () => {
  test('KHÔNG ghi khi inner không hỗ trợ call (request không bao giờ gửi)', async () => {
    const { quota, dispose } = freshLedger();
    const api = new QuotaCountingDataApi(new MinimalFakeApi(), quota, () => true);
    const before = quota.remaining('general');

    expect(await api.fetchFeaturedChannels('UCx')).toEqual([]);
    expect(await api.fetchPublicSubscriptions('UCx')).toBeNull();
    expect(await api.fetchVideoComments({ videoId: 'v' })).toEqual([]);
    expect(await api.listUploadsPlaylistItems('UUx', 12)).toEqual([]);
    expect(await api.resolveChannelByHandle('@x')).toBeNull();

    expect(quota.remaining('general')).toBe(before);
    dispose();
  });

  test('search không hỗ trợ → ném capability_missing và KHÔNG ghi bucket search', async () => {
    const { quota, dispose } = freshLedger();
    const api = new QuotaCountingDataApi(new MinimalFakeApi(), quota, () => true);
    const before = quota.remaining('search');
    await expect(api.search({ q: 'x' })).rejects.toMatchObject({ code: 'capability_missing' });
    expect(quota.remaining('search')).toBe(before);
    dispose();
  });

  test('transport chết SAU khi request khởi phát vẫn ghi attempted call đúng 1 lần', async () => {
    const { quota, dispose } = freshLedger();
    const inner = new FullFakeApi();
    inner.failTransport = true;
    const api = new QuotaCountingDataApi(inner, quota, () => true);
    const before = quota.remaining('general');

    await expect(api.fetchChannelStatistics(['UCx'])).rejects.toMatchObject({ code: 'provider_error' });
    expect(inner.channelStatCalls).toBe(1);
    expect(before - quota.remaining('general')).toBe(1);
    dispose();
  });

  test('retry lộ rõ trên sổ: 3 lần thử = 3 unit, không bị gộp', async () => {
    const { quota, dispose } = freshLedger();
    const inner = new FullFakeApi();
    inner.failTransport = true;
    const api = new QuotaCountingDataApi(inner, quota, () => true);
    const before = quota.remaining('general');

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(api.fetchChannelStatistics(['UCx'])).rejects.toThrow();
    }
    expect(before - quota.remaining('general')).toBe(3);
    dispose();
  });

  test('input rỗng không ghi sổ và không gọi inner', async () => {
    const { quota, dispose } = freshLedger();
    const inner = new FullFakeApi();
    const api = new QuotaCountingDataApi(inner, quota, () => true);
    const before = quota.remaining('general');
    expect(await api.fetchVideoStatistics([])).toEqual(new Map());
    expect(await api.fetchChannelStatistics([])).toEqual(new Map());
    expect(inner.videoStatCalls).toBe(0);
    expect(quota.remaining('general')).toBe(before);
    dispose();
  });
});

// ---------------------------------------------------------------------------
// quotaDayOf / isSameQuotaDay — chặn nguyên một lớp bug so ngày
// ---------------------------------------------------------------------------

describe('quotaDayOf — so timestamp với quota-day', () => {
  test('quy timestamp UTC về ngày Pacific, không cắt chuỗi', () => {
    // 2026-08-22T06:08Z = 2026-08-21 23:08 Pacific → quota-day vẫn là 08-21.
    // Cắt chuỗi `slice(0,10)` sẽ ra 08-22 và lệch mất một ngày.
    expect(quotaDayOf('2026-08-22T06:08:28.511Z')).toBe('2026-08-21');
    expect('2026-08-22T06:08:28.511Z'.slice(0, 10)).toBe('2026-08-22');
  });

  test('nhận cả Date lẫn chuỗi ISO', () => {
    const at = new Date('2026-08-22T06:08:28.511Z');
    expect(quotaDayOf(at)).toBe(quotaDayOf(at.toISOString()));
  });

  test('rỗng/null/không parse được → null', () => {
    expect(quotaDayOf(null)).toBeNull();
    expect(quotaDayOf(undefined)).toBeNull();
    expect(quotaDayOf('')).toBeNull();
    expect(quotaDayOf('không phải ngày')).toBeNull();
  });

  test('chuỗi chỉ-có-ngày bị TỪ CHỐI ồn ào, không fail im lặng', () => {
    // new Date('2026-08-21') = nửa đêm UTC → quy về Pacific lùi thành 08-20.
    // Đúng loại lệch ngày mà hàm này tồn tại để chặn, nên phải ném chứ không
    // được trả một giá trị sai trông có vẻ hợp lệ.
    expect(() => quotaDayOf('2026-08-21')).toThrow(/đã là một quota-day/);
  });
});

describe('isSameQuotaDay', () => {
  test('hai mốc trong cùng ngày Pacific → true, kể cả khác ngày UTC', () => {
    // 06:08Z ngày 22 và 20:00Z ngày 21 đều rơi vào Pacific 08-21.
    expect(isSameQuotaDay('2026-08-22T06:08:00Z', '2026-08-21T20:00:00Z')).toBe(true);
  });

  test('khác ngày Pacific → false', () => {
    expect(isSameQuotaDay('2026-08-22T08:00:00Z', '2026-08-21T08:00:00Z')).toBe(false);
  });

  test('thiếu dữ liệu → false, không đoán', () => {
    expect(isSameQuotaDay(null, new Date())).toBe(false);
    expect(isSameQuotaDay('', '')).toBe(false);
  });
});
