/**
 * auto-loop-hardgate.test.ts — cổng cứng P0 cho Spy Auto-Loop.
 * Hợp đồng: `plan/codex/spy-autoloop-hardgate.md` (owner: codex).
 *
 * G1 quota ledger · G2 search budget · G3 restart idempotency
 * G5 truthful output · G7 language post-filter
 * (G4 và G6 nằm ở packages/daemon — không thuộc file này.)
 *
 * BỐN NGUYÊN TẮC CỦA FILE NÀY, đừng "dọn dẹp" mất:
 *
 * 1. **Bảng chi phí là oracle ĐỘC LẬP.** Mọi con số unit/bucket dưới đây là
 *    literal, chép từ tài liệu Google, KHÔNG import `QUOTA_COST`, không gọi
 *    `QuotaLedger.consume()` để tự sinh kỳ vọng, không đọc internals của
 *    decorator. Import hằng số của chính code đang test chỉ chứng minh code nhất
 *    quán với chính nó — bằng chứng vòng tròn, không phải bằng chứng chi phí đúng.
 * 2. **Đếm ở biên transport thật.** Các case by-ids/comments dùng
 *    `YouTubeDataApiAdapter` THẬT + key giả + `fetch` bị mock, đếm URL request
 *    thực sự phát ra. Một port giả được gọi 1 lần với 51 ID KHÔNG chứng minh
 *    được là 2 HTTP request.
 * 3. **Đi đúng đường production.** `TraceDataApi` luôn nằm trong
 *    `QuotaCountingDataApi(hasKey: () => true)` và chạy qua đúng
 *    SpyService/DiscoveryService/LoopRunner mà production dùng, không test số
 *    học quota tách rời.
 * 4. **Không skip/todo/only, không bypass có điều kiện.** Mọi assertion G1–G7
 *    trong file phải chạy, trên data root tạm sạch, không cần API key thật.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { SpyService } from '../src/index.ts';
import { SpyStore } from '../src/store.ts';
import { QuotaLedger, quotaDay, quotaDayOf } from '../src/quota.ts';
import { QuotaCountingDataApi } from '../src/adapters/quota-counting-data-api.ts';
import { YouTubeDataApiAdapter } from '../src/adapters/data-api.ts';
import { DiscoveryService } from '../src/discovery.ts';
import { LoopRunner } from '../src/loop/runner.ts';
import { AppError } from '../src/errors.ts';
import type { YoutubePort, YoutubeTranscript, YoutubeVideoInfo } from '../src/adapters/ytdlp.ts';
import type {
  ChannelStatistics,
  CommentThread,
  PlaylistVideoItem,
  SearchHit,
  SearchInput,
  VideoStatistics,
  YouTubeDataApiPort,
} from '../src/adapters/data-api.ts';

// ---------------------------------------------------------------------------
// ORACLE ĐỘC LẬP — chi phí quota theo tài liệu Google, viết tay.
// Nguồn: developers.google.com/youtube/v3/determine_quota_cost
// Từ 01/06/2026 search.list có bucket riêng 100 call/ngày (1 unit/call);
// mọi endpoint list còn lại 1 unit trong bucket general 10.000/ngày.
// KHÔNG thay bằng import QUOTA_COST — xem nguyên tắc 1 ở đầu file.
// ---------------------------------------------------------------------------
const EXPECTED_COST: Record<string, { bucket: 'search' | 'general'; units: number }> = {
  'search.list': { bucket: 'search', units: 1 },
  'videos.list': { bucket: 'general', units: 1 },
  'channels.list': { bucket: 'general', units: 1 },
  'playlistItems.list': { bucket: 'general', units: 1 },
  'channelSections.list': { bucket: 'general', units: 1 },
  'subscriptions.list': { bucket: 'general', units: 1 },
  'commentThreads.list': { bucket: 'general', units: 1 },
};

/** Mọi op phải có case trace không rỗng — thiếu một op là FAIL (G1). */
const ALL_QUOTA_OPS = Object.keys(EXPECTED_COST);

const roots: string[] = [];
const openStores: SpyStore[] = [];
const realFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const store of openStores.splice(0)) {
    try { store.close(); } catch { /* đã đóng */ }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

// ---------------------------------------------------------------------------
// TraceDataApi — ghi lại từng request endpoint và QUAN SÁT SỔ ngay lúc request
// bắt đầu, để chứng minh consume() đã xảy ra TRƯỚC đó chứ không phải sau.
// ---------------------------------------------------------------------------

interface TraceEvent {
  endpoint: string;
  detail: string;
  /** calls đã ghi trong bucket tại THỜI ĐIỂM request bắt đầu. */
  ledgerCallsAtEntry: number;
  /** units đã ghi trong bucket tại THỜI ĐIỂM request bắt đầu. */
  ledgerUnitsAtEntry: number;
}

class TraceDataApi implements YouTubeDataApiPort {
  readonly events: TraceEvent[] = [];
  hitsPerSearch: SearchHit[] = [];
  nextPageToken: string | null = null;
  videoTitles: string[] = [];
  videoAudioLang: string | null = null;
  uploadsCount = 12;
  failOn: string | null = null;

  private quota: QuotaLedger | null;

  constructor(quota: QuotaLedger | null = null) {
    this.quota = quota;
  }

  /**
   * Gắn ledger sau khi khởi tạo — `SpyService` tự dựng store bên trong nên
   * không thể dựng ledger trước nó. Trace PHẢI quan sát đúng cái sổ mà decorator
   * đang ghi, nếu không phép so "đã charge trước request" là so nhầm hai cuốn sổ.
   */
  attachLedger(quota: QuotaLedger): void {
    this.quota = quota;
  }

  /** Gọi ở dòng ĐẦU của mỗi method = thời điểm request bắt đầu. */
  private enter(endpoint: string, detail = ''): void {
    if (!this.quota) throw new Error('TraceDataApi chưa attachLedger');
    const bucket = EXPECTED_COST[endpoint]!.bucket;
    const status = this.quota.status().buckets.find((b) => b.bucket === bucket)!;
    this.events.push({
      endpoint,
      detail,
      ledgerCallsAtEntry: status.calls,
      ledgerUnitsAtEntry: status.used,
    });
    if (this.failOn === endpoint) {
      throw new AppError('provider_error', `YouTube Data API 503 (${endpoint})`, { retryable: true });
    }
  }

  count(endpoint: string): number {
    return this.events.filter((e) => e.endpoint === endpoint).length;
  }

  async fetchVideoStatistics(videoIds: readonly string[]): Promise<Map<string, VideoStatistics>> {
    this.enter('videos.list', `${videoIds.length} ids`);
    const map = new Map<string, VideoStatistics>();
    videoIds.forEach((videoId, index) => {
      map.set(videoId, {
        videoId, likeCount: 10, commentCount: 2, viewCount: 30_000,
        publishedAt: new Date(Date.now() - index * 7 * 86_400_000).toISOString(),
        publishedAtPrecision: 'second', durationSec: 720, tags: [],
        title: this.videoTitles[index] ?? `Video ${index}`,
        channelId: 'UCtraced', channelTitle: 'Traced',
        thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        defaultAudioLanguage: this.videoAudioLang,
        defaultLanguage: null,
      });
    });
    return map;
  }

  async fetchChannelStatistics(channelIds: readonly string[]): Promise<Map<string, ChannelStatistics>> {
    this.enter('channels.list', `${channelIds.length} ids`);
    const map = new Map<string, ChannelStatistics>();
    for (const channelId of channelIds) {
      map.set(channelId, {
        channelId, title: `Kênh ${channelId}`, description: 'giải thích tài chính cá nhân',
        subscriberCount: 80_000, videoCount: 120, viewCount: 6_000_000,
        uploadsPlaylistId: `UU${channelId.slice(2)}`,
        publishedAt: new Date(Date.now() - 500 * 86_400_000).toISOString(),
        country: 'VN',
      });
    }
    return map;
  }

  async search(input: SearchInput): Promise<{ hits: SearchHit[]; nextPageToken: string | null }> {
    this.enter('search.list', `q=${input.q ?? ''} page=${input.pageToken ?? '1'}`);
    return { hits: this.hitsPerSearch, nextPageToken: this.nextPageToken };
  }

  async fetchFeaturedChannels(channelId: string): Promise<string[]> {
    this.enter('channelSections.list', channelId);
    return [];
  }

  async fetchPublicSubscriptions(channelId: string): Promise<string[] | null> {
    this.enter('subscriptions.list', channelId);
    return [];
  }

  async fetchVideoComments(): Promise<CommentThread[]> {
    this.enter('commentThreads.list');
    return [];
  }

  async listUploadsPlaylistItems(uploadsPlaylistId: string, limit: number): Promise<PlaylistVideoItem[]> {
    this.enter('playlistItems.list', uploadsPlaylistId);
    const channelId = `UC${uploadsPlaylistId.slice(2)}`;
    return Array.from({ length: Math.min(limit, this.uploadsCount) }, (_, index) => ({
      videoId: `${channelId}#${index}`,
      publishedAt: new Date(Date.now() - index * 7 * 86_400_000).toISOString(),
      title: this.videoTitles[index] ?? `Video ${index}`,
      position: index,
    }));
  }
}

/** Bộ đồ nghề chạy ĐÚNG đường production: Trace → decorator → service thật. */
async function harness() {
  const root = await tempRoot('spy-hardgate-');
  const store = new SpyStore(join(root, 'spy.sqlite'));
  openStores.push(store);
  const quota = new QuotaLedger(store);
  const trace = new TraceDataApi(quota);
  const counting = new QuotaCountingDataApi(trace, quota, () => true);
  const discovery = new DiscoveryService(store, counting, quota);
  const loop = new LoopRunner({
    store, quota, discovery, dataApi: counting, dataRoot: root,
  });
  return { root, store, quota, trace, counting, discovery, loop };
}

function ledger(store: SpyStore, bucket: 'search' | 'general'): { units: number; calls: number } {
  return store.getQuotaUsage(bucket, quotaDay());
}

const VI_TITLES = [
  'Lãi kép hoạt động như thế nào', 'Tại sao bạn không tiết kiệm được',
  'Giải thích quỹ ETF cho người mới', 'Bẫy tiêu dùng và cách thoát ra',
  'Nợ tốt và nợ xấu khác nhau ở đâu', 'Quản lý chi tiêu thu nhập thấp',
  'Đầu tư cho người mới bắt đầu', 'Sự thật về bảo hiểm nhân thọ',
  'Ba sai lầm khi mua nhà trả góp', 'Thu nhập thụ động có thật không',
  'Lạm phát ăn mòn tiền ra sao', 'Tư duy tài chính của người giàu',
];
// ===========================================================================
// G1 quota ledger — sổ khớp call thật, cho MỌI op trong bảng chi phí
// ===========================================================================

describe('G1 quota ledger matches actual API calls', () => {
  test('G1 quota ledger — search.list: mỗi request/trang là một call riêng trên bucket search', async () => {
    const { store, trace, discovery, counting } = await harness();
    trace.nextPageToken = 'PAGE2';

    const before = ledger(store, 'search');
    await discovery.discoverVideos(
      {
        version: 1,
        markets: [{ id: 'vi', label: 'VN', relevanceLanguage: 'vi', regionCode: 'VN', seedKeywords: ['tài chính'] }],
        negativeKeywords: [],
        format: { videoDuration: 'any', minDurationSec: 0, maxDurationSec: 0 },
        channelFilter: { minSubscribers: 0, maxSubscribers: 0, minVideos: 0 },
        excludeChannelIds: [],
        scoring: { keywordOverlap: 40, subscriberBand: 20, uploadRecency: 15, avgViewsPerVideo: 15, languageMatch: 10 },
        notes: '',
      },
      { query: 'lãi kép', marketId: 'vi' },
    );
    const after = ledger(store, 'search');

    // Trang 1 xong. Bây giờ PHÁT THẬT request trang 2 bằng pageToken vừa nhận —
    // một token trả về mà không ai dùng thì không chứng minh được gì về phân trang.
    expect(trace.count('search.list')).toBe(1);
    await counting.search({ q: 'lãi kép', type: 'video', pageToken: 'PAGE2' });
    const afterPage2 = ledger(store, 'search');

    // Trang 2 là MỘT CALL NỮA, tính tiền riêng.
    expect(trace.count('search.list')).toBe(2);
    expect(trace.events.map((e) => e.detail)).toEqual([
      expect.stringContaining('page=1'),
      expect.stringContaining('page=PAGE2'),
    ]);
    expect(afterPage2.calls - before.calls).toBe(2);
    expect(afterPage2.units - before.units).toBe(2 * EXPECTED_COST['search.list']!.units);
    // Sổ đã ghi trước khi mỗi request chạy.
    expect(trace.events[0]!.ledgerCallsAtEntry).toBe(1);
    expect(trace.events[1]!.ledgerCallsAtEntry).toBe(2);
    // Bucket search tách khỏi general.
    expect(ledger(store, 'general').calls).toBe(0);
  });

  test('G1 quota ledger — graph: channelSections.list và subscriptions.list mỗi request một dòng sổ', async () => {
    const { store, trace, discovery } = await harness();
    const before = ledger(store, 'general');
    await discovery.expandGraph(
      {
        version: 1,
        markets: [{ id: 'vi', label: 'VN', relevanceLanguage: 'vi', regionCode: 'VN', seedKeywords: ['x'] }],
        negativeKeywords: [],
        format: { videoDuration: 'any', minDurationSec: 0, maxDurationSec: 0 },
        channelFilter: { minSubscribers: 0, maxSubscribers: 0, minVideos: 0 },
        excludeChannelIds: [],
        scoring: { keywordOverlap: 40, subscriberBand: 20, uploadRecency: 15, avgViewsPerVideo: 15, languageMatch: 10 },
        notes: '',
      },
      { channelIds: ['UCseed0000000000000000001'], includeSubscriptions: true },
    );
    const after = ledger(store, 'general');

    expect(trace.count('channelSections.list')).toBe(1);
    expect(trace.count('subscriptions.list')).toBe(1);
    expect(after.calls - before.calls).toBe(2);
    expect(after.units - before.units).toBe(
      EXPECTED_COST['channelSections.list']!.units + EXPECTED_COST['subscriptions.list']!.units,
    );
    for (const event of trace.events) {
      expect(event.ledgerCallsAtEntry).toBeGreaterThan(0);
    }
  });

  test('G1 quota ledger — commentThreads.list qua đường production ghi đúng một dòng', async () => {
    const { store, trace, counting } = await harness();
    const before = ledger(store, 'general');
    await counting.fetchVideoComments!({ videoId: 'vid1' });
    const after = ledger(store, 'general');

    expect(trace.count('commentThreads.list')).toBe(1);
    expect(after.calls - before.calls).toBe(1);
    expect(after.units - before.units).toBe(EXPECTED_COST['commentThreads.list']!.units);
    expect(trace.events[0]!.ledgerCallsAtEntry).toBe(1);
  });

  test('G1 quota ledger — transport chết sau khi request khởi phát: ghi ĐÚNG một lần, retry lộ rõ', async () => {
    const { store, trace, counting } = await harness();
    trace.failOn = 'channels.list';

    const before = ledger(store, 'general');
    await expect(counting.fetchChannelStatistics(['UCfail000000000000000001']))
      .rejects.toMatchObject({ code: 'provider_error' });
    const afterFirst = ledger(store, 'general');

    // Request đã khởi phát → attempted call ghi đúng 1 lần, không nhiều hơn.
    expect(trace.count('channels.list')).toBe(1);
    expect(afterFirst.calls - before.calls).toBe(1);
    expect(afterFirst.units - before.units).toBe(EXPECTED_COST['channels.list']!.units);

    // Hai lần retry nữa: mỗi lần một dòng riêng trên CẢ trace lẫn ledger,
    // không bị gộp và cũng không bị bỏ qua.
    await expect(counting.fetchChannelStatistics(['UCfail000000000000000001'])).rejects.toThrow();
    await expect(counting.fetchChannelStatistics(['UCfail000000000000000001'])).rejects.toThrow();
    const afterRetries = ledger(store, 'general');
    expect(trace.count('channels.list')).toBe(3);
    expect(afterRetries.calls - before.calls).toBe(3);
    expect(afterRetries.units - before.units).toBe(3 * EXPECTED_COST['channels.list']!.units);
  });

  test('G1 quota ledger — thiếu key: không có trace event, không có dòng sổ, lỗi capability_missing', async () => {
    const root = await tempRoot('spy-hardgate-nokey-');
    const store = new SpyStore(join(root, 'spy.sqlite'));
    openStores.push(store);
    const quota = new QuotaLedger(store);
    const trace = new TraceDataApi(quota);
    // hasKey=false = chưa cấu hình youtubeDataApiKey.
    const counting = new QuotaCountingDataApi(trace, quota, () => false);

    await expect(counting.fetchChannelStatistics(['UCx0000000000000000000001']))
      .rejects.toMatchObject({ code: 'capability_missing' });
    await expect(counting.search({ q: 'x' })).rejects.toMatchObject({ code: 'capability_missing' });

    expect(trace.events).toHaveLength(0);
    expect(ledger(store, 'general')).toEqual({ units: 0, calls: 0 });
    expect(ledger(store, 'search')).toEqual({ units: 0, calls: 0 });
  });

});

// ---------------------------------------------------------------------------
// G1 — biên transport THẬT: YouTubeDataApiAdapter + key giả + fetch mock.
// Đếm URL phát ra, chứng minh 51 ID = 2 request.
// ---------------------------------------------------------------------------

function mockTransport(): { urls: URL[] } {
  const urls: URL[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    urls.push(url);
    return new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { urls };
}

/** Transport giả chết ở request thứ `failAt` (1-based) của cùng endpoint. */
function mockTransportFailingAt(failAt: number): { urls: URL[] } {
  const urls: URL[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    urls.push(url);
    const nth = urls.filter((u) => u.pathname === url.pathname).length;
    if (nth === failAt) return new Response('boom', { status: 503 });
    return new Response(JSON.stringify({ items: [] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { urls };
}

/** Transport giả trả về đúng các id được hỏi, để kiểm việc gộp kết quả các lô. */
function mockTransportReturningIds(): { urls: URL[] } {
  const urls: URL[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    urls.push(url);
    const ids = (url.searchParams.get('id') ?? '').split(',').filter(Boolean);
    return new Response(JSON.stringify({
      items: ids.map((id) => ({ id, snippet: {}, statistics: {}, contentDetails: {} })),
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { urls };
}

/** Decorator mới quanh cùng một trace/ledger — mô phỏng hai runner trong một daemon. */
function counting0(_store: SpyStore, quota: QuotaLedger, trace: TraceDataApi): QuotaCountingDataApi {
  return new QuotaCountingDataApi(trace, quota, () => true);
}

describe('G1 quota ledger — biên transport thật (YouTubeDataApiAdapter)', () => {
  test('G1 quota ledger — videosByIds: 51 ID phát ra ĐÚNG 2 request và ghi 2 unit', async () => {
    const root = await tempRoot('spy-hardgate-http-');
    const { urls } = mockTransport();
    const spy = new SpyService({
      dataRoot: join(root, 'spy'),
      config: { youtubeDataApiKey: 'dummy-key-for-transport-test', concurrency: 1 },
    });
    await spy.init();

    // `SpyService.videosByIds` chặn >50 id ở tầng input, nên phần chứng minh
    // batching phải đi thẳng vào adapter THẬT — vẫn bọc decorator y như production.
    const quota = new QuotaLedger(spy.store);
    const adapter = new YouTubeDataApiAdapter('dummy-key-for-transport-test');
    const counting = new QuotaCountingDataApi(adapter, quota, () => true);

    const before = spy.store.getQuotaUsage('general', quotaDay());
    await counting.fetchVideoStatistics(Array.from({ length: 51 }, (_, i) => `vid${i}`));
    const after = spy.store.getQuotaUsage('general', quotaDay());

    const videoUrls = urls.filter((u) => u.pathname.endsWith('/videos'));
    // 50 ID/lô → 51 ID BẮT BUỘC là hai HTTP request, không phải một.
    expect(videoUrls).toHaveLength(2);
    expect(videoUrls[0]!.searchParams.get('id')!.split(',')).toHaveLength(50);
    expect(videoUrls[1]!.searchParams.get('id')!.split(',')).toHaveLength(1);
    expect(after.calls - before.calls).toBe(2);
    expect(after.units - before.units).toBe(2 * EXPECTED_COST['videos.list']!.units);

    // Và đường service thật (≤50 id) cũng ghi sổ đúng một call.
    const beforeService = spy.store.getQuotaUsage('general', quotaDay());
    await spy.videosByIds(['vidA', 'vidB']);
    const afterService = spy.store.getQuotaUsage('general', quotaDay());
    expect(urls.filter((u) => u.pathname.endsWith('/videos'))).toHaveLength(3);
    expect(afterService.calls - beforeService.calls).toBe(1);
    spy.store.close();
  });

  test('G1 quota ledger — channelsByIds + handle resolve: mỗi request một dòng sổ', async () => {
    const root = await tempRoot('spy-hardgate-http-');
    const { urls } = mockTransport();
    const spy = new SpyService({
      dataRoot: join(root, 'spy'),
      config: { youtubeDataApiKey: 'dummy-key-for-transport-test', concurrency: 1 },
    });
    await spy.init();

    const before = spy.store.getQuotaUsage('general', quotaDay());
    await spy.channelsByIds(['UCaaaaaaaaaaaaaaaaaaaaaa', '@handleonly']);
    const after = spy.store.getQuotaUsage('general', quotaDay());

    const channelUrls = urls.filter((u) => u.pathname.endsWith('/channels'));
    // 1 request cho id list + 1 request cho forHandle.
    expect(channelUrls).toHaveLength(2);
    expect(channelUrls.some((u) => u.searchParams.get('forHandle') === 'handleonly')).toBe(true);
    expect(after.calls - before.calls).toBe(2);
    expect(after.units - before.units).toBe(2 * EXPECTED_COST['channels.list']!.units);
    spy.store.close();
  });

  test('G1 quota ledger — videoComments: một request commentThreads, một dòng sổ', async () => {
    const root = await tempRoot('spy-hardgate-http-');
    const { urls } = mockTransport();
    const spy = new SpyService({
      dataRoot: join(root, 'spy'),
      config: { youtubeDataApiKey: 'dummy-key-for-transport-test', concurrency: 1 },
    });
    await spy.init();

    const before = spy.store.getQuotaUsage('general', quotaDay());
    await spy.videoComments({ videoId: 'vid1' });
    const after = spy.store.getQuotaUsage('general', quotaDay());

    const commentUrls = urls.filter((u) => u.pathname.endsWith('/commentThreads'));
    expect(commentUrls).toHaveLength(1);
    expect(after.calls - before.calls).toBe(1);
    expect(after.units - before.units).toBe(EXPECTED_COST['commentThreads.list']!.units);
    spy.store.close();
  });
});

// ---------------------------------------------------------------------------
// G1 — đường ACQUISITION (deep scan) qua SpyService + decorator.
// Không phải chỉ discovery/loop: hợp đồng đòi trace đi qua đúng đường
// acquisition mà production dùng.
// ---------------------------------------------------------------------------

/** YoutubePort tối thiểu — deep scan qua Data API không cần yt-dlp. */
function stubYoutube(): YoutubePort {
  const info = (videoId: string): YoutubeVideoInfo => ({
    sourceVideoId: videoId,
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    title: `Video ${videoId}`,
    channelTitle: 'Traced',
    channelId: 'UCacq00000000000000000001',
    viewCount: 1000,
    durationSec: 600,
    publishedAt: '2026-08-01T00:00:00.000Z',
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  });
  return {
    inspectVideo: async (url: string) => info(url.split('v=')[1] ?? 'vid'),
    listChannel: async () => [],
    streamUrl: async () => '',
    thumbnail: async () => ({ bytes: new Uint8Array([0xff, 0xd8, 0xff]), mimeType: 'image/jpeg' }),
    fetchTranscript: async (): Promise<YoutubeTranscript> => ({
      status: 'ok', language: 'vi', source: 'manual',
      segments: [{ startSec: 0, endSec: 2, text: 'xin chào' }],
    }),
  };
}

describe('G1 quota ledger — đường acquisition (deep scan)', () => {
  test('G1 quota ledger — channelSpy qua SpyService ghi sổ channels/playlistItems/videos', async () => {
    const root = await tempRoot('spy-hardgate-acq-');
    const trace = new TraceDataApi();
    trace.videoTitles = VI_TITLES;
    trace.uploadsCount = 3;

    // Đúng đường production: SpyService tự bọc adapter inject bằng
    // QuotaCountingDataApi rồi đưa cho AcquisitionService.
    const spy = new SpyService({
      dataRoot: join(root, 'spy'),
      youtube: stubYoutube(),
      dataApi: trace,
      config: { concurrency: 1 },
    });
    await spy.init();
    // Quan sát CHÍNH cuốn sổ mà service đang ghi.
    trace.attachLedger(spy.quota);

    const before = spy.store.getQuotaUsage('general', quotaDay());
    const started = spy.channelSpy({
      url: 'https://www.youtube.com/channel/UCacq00000000000000000001',
      topN: 1,
      selectionMode: 'latest',
      scanLimit: 3,
      rankBy: 'views',
      minDurationSec: 0,
      depth: 'metadata',
      idempotencyKey: 'hardgate-acquisition-001',
    });
    let op = await spy.wait(started.operationId, 10_000);
    while (op.status === 'queued' || op.status === 'running') {
      op = await spy.wait(started.operationId, 10_000);
    }
    const after = spy.store.getQuotaUsage('general', quotaDay());

    // Ba endpoint của deep scan đều đi qua decorator và vào sổ.
    expect(trace.count('channels.list')).toBeGreaterThan(0);
    expect(trace.count('playlistItems.list')).toBeGreaterThan(0);
    expect(trace.count('videos.list')).toBeGreaterThan(0);

    const tracedGeneral = trace.events.filter((e) => EXPECTED_COST[e.endpoint]!.bucket === 'general');
    const expectedUnits = tracedGeneral.reduce((sum, e) => sum + EXPECTED_COST[e.endpoint]!.units, 0);
    expect(after.calls - before.calls).toBe(tracedGeneral.length);
    expect(after.units - before.units).toBe(expectedUnits);
    // Ghi sổ trước request, không phải sau.
    tracedGeneral.forEach((event, index) => {
      expect(event.ledgerCallsAtEntry).toBe(index + 1);
    });
    spy.store.close();
  });
});


describe('G3 restart idempotency — report phải nằm trên đĩa trước khi tick done (F3)', () => {
  test('G3 restart idempotency — chạy report hai lần không sinh report thứ hai', async () => {
    const { store } = await harness();
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi' });
    const day = quotaDay();
    const first = store.insertDailyReportOnce({
      reportId: 'r1', reportDate: day, topicId: 'fin', summaryJson: '{}', markdown: '# a',
    });
    const second = store.insertDailyReportOnce({
      reportId: 'r2', reportDate: day, topicId: 'fin', summaryJson: '{}', markdown: '# b',
    });
    expect(first).toEqual({ created: true, reportId: 'r1' });
    expect(second).toEqual({ created: false, reportId: 'r1' });
    expect(store.listDailyReports('fin').length).toBe(1);
  });
});

// ===========================================================================
// T1 — MỘT loại "hôm nay" duy nhất: quota-day Pacific
//
// Hệ thống có hai khái niệm ngày (UTC calendar và quota-day America/Los_Angeles)
// và không có gì buộc người viết chọn đúng loại. Lỗi này đã xảy ra BA lần độc
// lập trong cùng một nhánh, ba người viết khác nhau — nên nó là bẫy thiết kế,
// không phải sơ suất. Ba case dưới đây là ba khung giờ mà bug thật đã xảy ra.
//
// Không case nào được suy ra kỳ vọng bằng `toISOString().slice(0,10)`; mọi mốc
// đều là literal đối chiếu với `quotaDay()`.
// ===========================================================================

describe('T1 quota day — một loại "hôm nay" duy nhất (Pacific)', () => {
  test('T1 quota day — mốc UTC/Pacific: 2026-08-22T06:08Z thuộc quota-day 2026-08-21', () => {
    // Đây là cái bẫy, viết ra tường minh: lịch UTC đã sang ngày 22 trong khi
    // quota-day vẫn là 21. Mọi so sánh cắt chuỗi ISO đều sai đúng ở khung này.
    expect(quotaDay(new Date('2026-08-22T06:08:28.511Z'))).toBe('2026-08-21');
    expect(quotaDayOf('2026-08-22T06:08:28.511Z')).toBe('2026-08-21');
  });

  test('T1 quota day — digest 08:00 giờ VN đọc report_date do quotaDay(now) ghi, không phải ngày UTC', async () => {
    const root = await tempRoot('spy-t1-digest-');
    const store = new SpyStore(join(root, 'spy.sqlite'));
    openStores.push(store);
    const quota = new QuotaLedger(store);
    const trace = new TraceDataApi(quota);
    const counting = new QuotaCountingDataApi(trace, quota, () => true);
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi' });

    // Tick 15:30 giờ VN ngày 22-08 = 08:30Z = 01:30 Pacific ngày 22-08.
    const tickNow = new Date('2026-08-22T08:30:00.000Z');
    expect(quotaDay(tickNow)).toBe('2026-08-22');
    const loop = new LoopRunner({
      store, quota, dataApi: counting, dataRoot: root,
      discovery: new DiscoveryService(store, counting, quota),
    });
    await loop.runTick('fin', { now: tickNow });

    // Digest 08:00 giờ VN sáng hôm sau = 01:00Z ngày 23-08 = 18:00 Pacific ngày 22-08.
    const digestNow = new Date('2026-08-23T01:00:00.000Z');
    // Lịch UTC lúc này đã là 23-08, nhưng quota-day vẫn là 22-08 — đúng chỗ
    // digest từng lọc trượt và im lặng không gửi gì.
    expect(quotaDay(digestNow)).toBe('2026-08-22');

    const report = store.getDailyReportByDate('fin', quotaDay(digestNow));
    expect(report).not.toBeNull();
    expect(String(report!['report_date'])).toBe('2026-08-22');
    // Tra bằng ngày lịch UTC thì không thấy gì — chính là bug.
    expect(store.getDailyReportByDate('fin', '2026-08-23')).toBeNull();
    store.close();
  });

  test('T1 quota day — hai phía nửa đêm Pacific sinh đúng hai key tick/report khác nhau', async () => {
    const root = await tempRoot('spy-t1-midnight-');
    const dbPath = join(root, 'spy.sqlite');
    const store = new SpyStore(dbPath);
    openStores.push(store);
    const quota = new QuotaLedger(store);
    const trace = new TraceDataApi(quota);
    const counting = new QuotaCountingDataApi(trace, quota, () => true);
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi' });
    const loop = new LoopRunner({
      store, quota, dataApi: counting, dataRoot: root,
      discovery: new DiscoveryService(store, counting, quota),
    });

    // PDT = UTC-7 trong tháng 8.
    const justBefore = new Date('2026-08-22T06:59:00.000Z'); // 23:59 Pacific 21-08
    const justAfter = new Date('2026-08-22T07:01:00.000Z');  // 00:01 Pacific 22-08
    expect(quotaDay(justBefore)).toBe('2026-08-21');
    expect(quotaDay(justAfter)).toBe('2026-08-22');

    const first = await loop.runTick('fin', { now: justBefore });
    const second = await loop.runTick('fin', { now: justAfter });

    // Hai phút cách nhau nhưng là HAI quota-day → hai tick, không phải một.
    expect(first.quotaDay).toBe('2026-08-21');
    expect(second.quotaDay).toBe('2026-08-22');
    expect(second.status).not.toBe('skipped_quota');

    const db = new Database(dbPath, { readonly: true });
    const days = (db.prepare(
      'SELECT quota_day FROM loop_ticks WHERE topic_id=? ORDER BY quota_day',
    ).all('fin') as Array<{ quota_day: string }>).map((r) => r.quota_day);
    const reportDates = (db.prepare(
      'SELECT report_date FROM daily_reports WHERE topic_id=? ORDER BY report_date',
    ).all('fin') as Array<{ report_date: string }>).map((r) => r.report_date);
    db.close();

    expect(days).toEqual(['2026-08-21', '2026-08-22']);
    expect(reportDates).toEqual(['2026-08-21', '2026-08-22']);
    store.close();
  });
});

// ===========================================================================
// H1 — charge phải ứng với TỪNG request thật, không phải cả lô
// ===========================================================================

describe('H1 quota ledger — charge theo từng request, không gộp cả lô', () => {
  test('H1 quota ledger — 51 ID, request ĐẦU chết: quan sát 1 request, sổ ghi 1', async () => {
    const root = await tempRoot('spy-h1-first-');
    const { urls } = mockTransportFailingAt(1);
    const store = new SpyStore(join(root, 'spy.sqlite'));
    openStores.push(store);
    const quota = new QuotaLedger(store);
    const counting = new QuotaCountingDataApi(
      new YouTubeDataApiAdapter('dummy-key-for-transport-test'), quota, () => true,
    );

    const before = store.getQuotaUsage('general', quotaDay());
    await expect(
      counting.fetchVideoStatistics(Array.from({ length: 51 }, (_, i) => `vid${i}`)),
    ).rejects.toMatchObject({ code: 'provider_error' });
    const after = store.getQuotaUsage('general', quotaDay());

    // Chỉ MỘT request rời khỏi máy → sổ chỉ được ghi 1.
    expect(urls.filter((u) => u.pathname.endsWith('/videos'))).toHaveLength(1);
    expect(after.calls - before.calls).toBe(1);
    expect(after.units - before.units).toBe(1 * EXPECTED_COST['videos.list']!.units);
    store.close();
  });

  test('H1 quota ledger — 51 ID, request THỨ HAI chết: quan sát 2 request, sổ ghi 2', async () => {
    const root = await tempRoot('spy-h1-second-');
    const { urls } = mockTransportFailingAt(2);
    const store = new SpyStore(join(root, 'spy.sqlite'));
    openStores.push(store);
    const quota = new QuotaLedger(store);
    const counting = new QuotaCountingDataApi(
      new YouTubeDataApiAdapter('dummy-key-for-transport-test'), quota, () => true,
    );

    const before = store.getQuotaUsage('general', quotaDay());
    await expect(
      counting.fetchVideoStatistics(Array.from({ length: 51 }, (_, i) => `vid${i}`)),
    ).rejects.toMatchObject({ code: 'provider_error' });
    const after = store.getQuotaUsage('general', quotaDay());

    expect(urls.filter((u) => u.pathname.endsWith('/videos'))).toHaveLength(2);
    expect(after.calls - before.calls).toBe(2);
    store.close();
  });

  test('H1 quota ledger — channels.list cùng hình: 51 ID, request đầu chết → sổ ghi 1', async () => {
    const root = await tempRoot('spy-h1-chan-');
    const { urls } = mockTransportFailingAt(1);
    const store = new SpyStore(join(root, 'spy.sqlite'));
    openStores.push(store);
    const quota = new QuotaLedger(store);
    const counting = new QuotaCountingDataApi(
      new YouTubeDataApiAdapter('dummy-key-for-transport-test'), quota, () => true,
    );

    const before = store.getQuotaUsage('general', quotaDay());
    await expect(
      counting.fetchChannelStatistics(Array.from({ length: 51 }, (_, i) => `UCid${i}`)),
    ).rejects.toMatchObject({ code: 'provider_error' });
    const after = store.getQuotaUsage('general', quotaDay());

    expect(urls.filter((u) => u.pathname.endsWith('/channels'))).toHaveLength(1);
    expect(after.calls - before.calls).toBe(1);
    store.close();
  });

  test('H1 quota ledger — 51 ID thành công: 2 request, sổ 2, kết quả gộp đủ', async () => {
    const root = await tempRoot('spy-h1-ok-');
    const { urls } = mockTransportReturningIds();
    const store = new SpyStore(join(root, 'spy.sqlite'));
    openStores.push(store);
    const quota = new QuotaLedger(store);
    const counting = new QuotaCountingDataApi(
      new YouTubeDataApiAdapter('dummy-key-for-transport-test'), quota, () => true,
    );

    const before = store.getQuotaUsage('general', quotaDay());
    const result = await counting.fetchVideoStatistics(
      Array.from({ length: 51 }, (_, i) => `vid${i}`),
    );
    const after = store.getQuotaUsage('general', quotaDay());

    expect(urls.filter((u) => u.pathname.endsWith('/videos'))).toHaveLength(2);
    expect(after.calls - before.calls).toBe(2);
    // Chia lô ở decorator không được làm rơi kết quả của lô nào.
    expect(result.size).toBe(51);
    store.close();
  });

  test('H1 quota ledger — playlist ngắn hơn limit không bị tính thừa trang', async () => {
    const { store, trace, counting } = await harness();
    trace.uploadsCount = 12;
    const before = ledger(store, 'general');
    // Xin 500 nhưng playlist chỉ có 12 → đúng MỘT request, không phải 10.
    const items = await counting.listUploadsPlaylistItems!('UUshort00000000000001', 500);
    const after = ledger(store, 'general');

    expect(items).toHaveLength(12);
    expect(trace.count('playlistItems.list')).toBe(1);
    expect(after.calls - before.calls).toBe(1);
  });
});

// ===========================================================================
// H2 — chargeable work bị tuần tự hoá TOÀN CỤC ở P0
// ===========================================================================

describe('H2 quota ledger — hai topic không được tick chồng nhau', () => {
  test('H2 quota ledger — chạy tuần tự thì mỗi tick chỉ khai phần của chính nó', async () => {
    const { store, trace, loop } = await harness();
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi', dailySearchBudget: 2 });
    store.upsertTopic({ topicId: 'psy', label: 'Psych', market: 'vi', language: 'vi', dailySearchBudget: 2 });
    // v3: search chỉ thuộc weekly — keyword phải 'active' mới được nhịp này quét.
    store.upsertTopicKeyword({ topicId: 'fin', termKey: 'kw_f', displayTerm: 'lãi kép', relation: 'seed', status: 'active' });
    store.upsertTopicKeyword({ topicId: 'psy', termKey: 'kw_p', displayTerm: 'tâm lý', relation: 'seed', status: 'active' });

    await loop.runTick('fin', { mode: 'weekly' });
    await loop.runTick('psy', { mode: 'weekly' });

    const finTick = store.getTickByDay('fin', quotaDay())!;
    const psyTick = store.getTickByDay('psy', quotaDay())!;
    const totalTraced = trace.count('search.list');

    // Mỗi tick 1 search; tổng khai báo phải bằng tổng thật, không phải gấp đôi.
    expect(Number(finTick['search_calls_used'])).toBe(1);
    expect(Number(psyTick['search_calls_used'])).toBe(1);
    expect(Number(finTick['search_calls_used']) + Number(psyTick['search_calls_used']))
      .toBe(totalTraced);
    expect(ledger(store, 'search').calls).toBe(totalTraced);
  });
});

// ===========================================================================
// H3 — khối quota trong report chỉ có MỘT phạm vi
// ===========================================================================

describe('H3 truthful output — quota toàn ngày không trộn với quota của tick', () => {
  test('H3 truthful output — sổ ngày đã tiêu nhiều thì report không được khoe còn nguyên', async () => {
    const { store, trace, quota, loop } = await harness();
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi' });
    // v3 daily chỉ quét kênh 'active' — kênh này sinh playlistItems+videos.list,
    // tức tick phải khai generalUnitsUsed > 0.
    store.upsertTopicChannel({ topicId: 'fin', channelId: 'UCscope00000000000001', status: 'active' });
    trace.videoTitles = VI_TITLES;

    // Việc KHÁC đã tiêu 9000 unit trong ngày, trước khi tick chạy.
    quota.consume('videos.list', 9000);

    await loop.runTick('fin');

    const report = store.getDailyReportByDate('fin', quotaDay())!;
    const summary = JSON.parse(String(report['summary_json'])) as {
      quota: { generalUsed: number; generalLimit: number; searchUsed: number; searchRemainingDay: number };
      tick: { generalUnitsUsed: number; searchCallsUsed: number };
    };

    const dayLedger = ledger(store, 'general');
    // Khối `quota` là của CẢ NGÀY — phải phản ánh 9000 kia.
    expect(summary.quota.generalUsed).toBe(dayLedger.units);
    expect(summary.quota.generalUsed).toBeGreaterThanOrEqual(9000);
    // Và phải nhất quán với limit cùng namespace.
    expect(summary.quota.generalUsed + (summary.quota.generalLimit - dayLedger.units))
      .toBe(summary.quota.generalLimit);
    // Khối `tick` là của riêng tick — nhỏ hơn hẳn, và KHÔNG được là nguồn cho `quota`.
    expect(summary.tick.generalUnitsUsed).toBeLessThan(summary.quota.generalUsed);
    expect(summary.tick.generalUnitsUsed).toBeGreaterThan(0);
  });
});

// ===========================================================================
// H4 — provenance là union ĐÓNG, không có nhãn lạ
// ===========================================================================

const ALLOWED_DISCOVERY_SOURCES = [
  'search_video', 'search_channel', 'featured', 'subscription',
  'corpus_import', 'seed_config', 'manual_user',
];

describe('H4 provenance — mọi discovered_via đã lưu đều thuộc union đóng', () => {
  test('H4 provenance — SELECT DISTINCT discovered_via không có giá trị ngoài danh sách', async () => {
    const { store, trace, loop } = await harness();
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi' });
    store.upsertTopicKeyword({ topicId: 'fin', termKey: 'kw_a', displayTerm: 'lãi kép', relation: 'seed' });
    trace.videoTitles = VI_TITLES;

    // Ba đường tạo hàng cùng chạy: corpus import, search/enrich của loop.
    store.upsertChannel({
      channelId: 'UCh4corpus00000000001', title: 'Kênh đã spy',
      subscriberCount: 1000, videoCount: 10, totalViewCount: 5000,
      fetchedAt: '2026-08-01T00:00:00Z',
    });
    store.importCorpusChannelsToTopic('fin', 'vi');
    await loop.runTick('fin');

    const db = new Database(store.databasePath, { readonly: true });
    const rows = db.prepare('SELECT DISTINCT discovered_via FROM candidate_channels')
      .all() as Array<{ discovered_via: string }>;
    db.close();

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(ALLOWED_DISCOVERY_SOURCES).toContain(row.discovered_via);
    }
    // Không còn nhãn 'manual' chung chung ở bất kỳ đâu.
    expect(rows.map((r) => r.discovered_via)).not.toContain('manual');
  });

  test('H4 provenance — không đường tự động nào trong spy ghi manual_user', async () => {
    const { store, trace, loop } = await harness();
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi' });
    store.upsertTopicKeyword({ topicId: 'fin', termKey: 'kw_a', displayTerm: 'lãi kép', relation: 'seed' });
    trace.videoTitles = VI_TITLES;
    store.upsertChannel({
      channelId: 'UCh4auto000000000001', title: 'Kênh đã spy',
      subscriberCount: 1000, videoCount: 10, totalViewCount: 5000,
      fetchedAt: '2026-08-01T00:00:00Z',
    });
    store.importCorpusChannelsToTopic('fin', 'vi');
    await loop.runTick('fin');

    const db = new Database(store.databasePath, { readonly: true });
    const manualUser = db.prepare(
      "SELECT count(*) AS n FROM candidate_channels WHERE discovered_via='manual_user'",
    ).get() as { n: number };
    db.close();
    // manual_user chỉ được sinh bởi entrypoint của người (nằm ở daemon).
    expect(manualUser.n).toBe(0);
  });
});
