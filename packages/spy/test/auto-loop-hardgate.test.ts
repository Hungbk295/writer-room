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
import { evaluateChannelLanguage } from '../src/loop/language.ts';
import { LoopRunner } from '../src/loop/runner.ts';
import { buildDailyReport, renderReport } from '../src/loop/report.ts';
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
async function harness(opts: { checkpoint?: (name: string) => void | Promise<void> } = {}) {
  const root = await tempRoot('spy-hardgate-');
  const store = new SpyStore(join(root, 'spy.sqlite'));
  openStores.push(store);
  const quota = new QuotaLedger(store);
  const trace = new TraceDataApi(quota);
  const counting = new QuotaCountingDataApi(trace, quota, () => true);
  const discovery = new DiscoveryService(store, counting, quota);
  const loop = new LoopRunner({
    store, quota, discovery, dataApi: counting, dataRoot: root,
    ...(opts.checkpoint ? { checkpoint: opts.checkpoint } : {}),
  });
  return { root, store, quota, trace, counting, discovery, loop };
}

function ledger(store: SpyStore, bucket: 'search' | 'general'): { units: number; calls: number } {
  return store.getQuotaUsage(bucket, quotaDay());
}

function seedChannel(store: SpyStore, topicId: string, channelId: string): void {
  store.upsertCandidate({ channelId, market: 'vi', discoveredVia: 'corpus_import' });
  store.upsertTopicChannel({ topicId, channelId, status: 'new' });
}

const VI_TITLES = [
  'Lãi kép hoạt động như thế nào', 'Tại sao bạn không tiết kiệm được',
  'Giải thích quỹ ETF cho người mới', 'Bẫy tiêu dùng và cách thoát ra',
  'Nợ tốt và nợ xấu khác nhau ở đâu', 'Quản lý chi tiêu thu nhập thấp',
  'Đầu tư cho người mới bắt đầu', 'Sự thật về bảo hiểm nhân thọ',
  'Ba sai lầm khi mua nhà trả góp', 'Thu nhập thụ động có thật không',
  'Lạm phát ăn mòn tiền ra sao', 'Tư duy tài chính của người giàu',
];
const EN_TITLES = [
  'How compound interest works', 'Why you have no savings',
  'Index funds explained', 'The truth about consumer debt',
  'Good debt vs bad debt', 'How to budget on a low income',
  'Investing for beginners', 'What if you saved ten percent',
  'Three mistakes buying a house', 'Is passive income real',
  'How inflation eats your money', 'The money mindset of rich people',
];

// ===========================================================================
// G1 quota ledger — sổ khớp call thật, cho MỌI op trong bảng chi phí
// ===========================================================================

describe('G1 quota ledger matches actual API calls', () => {
  test('G1 quota ledger — deep enrich: channels.list + playlistItems.list + videos.list, ghi sổ trước khi request chạy', async () => {
    const { store, trace, loop } = await harness();
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi' });
    seedChannel(store, 'fin', 'UCenrich0000000000000001');
    trace.videoTitles = VI_TITLES;

    const generalBefore = ledger(store, 'general');
    await loop.runTick('fin');
    const generalAfter = ledger(store, 'general');

    // Trace: đúng ba endpoint của bước enrich, mỗi cái một lần cho một kênh.
    expect(trace.count('channels.list')).toBe(1);
    expect(trace.count('playlistItems.list')).toBe(1);
    expect(trace.count('videos.list')).toBe(1);

    // Ledger khớp một-đối-một với trace, unit theo oracle literal.
    const tracedGeneral = trace.events.filter((e) => EXPECTED_COST[e.endpoint]!.bucket === 'general');
    expect(generalAfter.calls - generalBefore.calls).toBe(tracedGeneral.length);
    const expectedUnits = tracedGeneral.reduce((sum, e) => sum + EXPECTED_COST[e.endpoint]!.units, 0);
    expect(generalAfter.units - generalBefore.units).toBe(expectedUnits);

    // Ghi sổ TRƯỚC request: tại lúc request thứ n bắt đầu, sổ đã có n call.
    tracedGeneral.forEach((event, index) => {
      expect(event.ledgerCallsAtEntry).toBe(index + 1);
      expect(event.ledgerUnitsAtEntry).toBe(index + 1);
    });
  });

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

  test('G1 quota ledger — MỌI op trong bảng chi phí đều có case trace không rỗng', async () => {
    const { store, trace, counting, discovery, loop } = await harness();
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi' });
    store.upsertTopicKeyword({ topicId: 'fin', termKey: 'lai_kep', displayTerm: 'lãi kép', relation: 'seed' });
    seedChannel(store, 'fin', 'UCall00000000000000000001');
    trace.videoTitles = VI_TITLES;

    const niche = {
      version: 1 as const,
      markets: [{ id: 'vi', label: 'VN', relevanceLanguage: 'vi', regionCode: 'VN', seedKeywords: ['tài chính'] }],
      negativeKeywords: [] as string[],
      format: { videoDuration: 'any' as const, minDurationSec: 0, maxDurationSec: 0 },
      channelFilter: { minSubscribers: 0, maxSubscribers: 0, minVideos: 0 },
      excludeChannelIds: [] as string[],
      scoring: { keywordOverlap: 40, subscriberBand: 20, uploadRecency: 15, avgViewsPerVideo: 15, languageMatch: 10 },
      notes: '',
    };
    await loop.runTick('fin');                                        // channels/playlistItems/videos + search
    await discovery.expandGraph(niche, {
      channelIds: ['UCseed0000000000000000002'], includeSubscriptions: true,
    });                                                               // channelSections + subscriptions
    await counting.fetchVideoComments!({ videoId: 'vid1' });          // commentThreads

    // Không op nào được phép vắng mặt.
    for (const op of ALL_QUOTA_OPS) {
      expect({ op, traced: trace.count(op) }).toEqual({ op, traced: expect.any(Number) });
      expect(trace.count(op)).toBeGreaterThan(0);
    }

    // Tổng sổ khớp tổng trace theo từng bucket, tính bằng oracle literal.
    for (const bucket of ['search', 'general'] as const) {
      const events = trace.events.filter((e) => EXPECTED_COST[e.endpoint]!.bucket === bucket);
      const expectedUnits = events.reduce((sum, e) => sum + EXPECTED_COST[e.endpoint]!.units, 0);
      const actual = ledger(store, bucket);
      expect(actual.calls).toBe(events.length);
      expect(actual.units).toBe(expectedUnits);
    }
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

// ===========================================================================
// G2 search budget — trần cứng, kể cả khi API mời trang tiếp
// ===========================================================================

describe('G2 search budget is a hard ceiling', () => {
  test('G2 search budget — 3 keyword, budget 2, API mời next page: tối đa 2 search call', async () => {
    const { store, trace, loop } = await harness();
    store.upsertTopic({
      topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi', dailySearchBudget: 2,
    });
    for (const [key, term] of [['kw_a', 'lãi kép'], ['kw_b', 'nợ xấu'], ['kw_c', 'quỹ etf']]) {
      store.upsertTopicKeyword({ topicId: 'fin', termKey: key!, displayTerm: term!, relation: 'seed' });
    }
    // API luôn mời trang tiếp — trần ngân sách phải thắng lời mời đó.
    trace.nextPageToken = 'PAGE2';

    const result = await loop.runTick('fin');

    expect(trace.count('search.list')).toBeLessThanOrEqual(2);
    expect(trace.count('search.list')).toBe(2);
    const searchLedger = ledger(store, 'search');
    expect(searchLedger.calls).toBe(trace.count('search.list'));
    expect(result.searchCallsUsed).toBe(trace.count('search.list'));

    const tick = store.getLastTick('fin')!;
    expect(Number(tick['search_calls_used'])).toBe(2);
    expect(Number(tick['search_calls_used'])).toBeLessThanOrEqual(2);
  });

  test('G2 search budget — token trang tiếp KHÔNG được biến thành call thứ ba', async () => {
    const { store, trace, loop } = await harness();
    store.upsertTopic({
      topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi', dailySearchBudget: 2,
    });
    for (const [key, term] of [['kw_a', 'lãi kép'], ['kw_b', 'nợ xấu'], ['kw_c', 'quỹ etf']]) {
      store.upsertTopicKeyword({ topicId: 'fin', termKey: key!, displayTerm: term!, relation: 'seed' });
    }
    trace.nextPageToken = 'PAGE2';

    await loop.runTick('fin');

    // Mọi event search — kể cả request trang — phải nằm trong trần 2.
    const searchEvents = trace.events.filter((e) => e.endpoint === 'search.list');
    expect(searchEvents).toHaveLength(2);
    // Và không có event nào là request phân trang: tick không đuổi theo token.
    expect(searchEvents.every((e) => e.detail.includes('page=1'))).toBe(true);
    expect(ledger(store, 'search').calls).toBe(2);
  });

  test('G2 search budget — sổ chỉ còn chỗ cho 1 call thì chỉ phát ra 1 request', async () => {
    const { store, trace, quota, loop } = await harness();
    store.upsertTopic({
      topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi', dailySearchBudget: 5,
    });
    for (const [key, term] of [['kw_a', 'lãi kép'], ['kw_b', 'nợ xấu'], ['kw_c', 'quỹ etf']]) {
      store.upsertTopicKeyword({ topicId: 'fin', termKey: key!, displayTerm: term!, relation: 'seed' });
    }
    // Bơm sẵn sổ: 100 call/ngày, dùng trước 99 → còn đúng 1.
    quota.consume('search.list', 99);
    expect(quota.remaining('search')).toBe(1);

    await loop.runTick('fin');
    expect(trace.count('search.list')).toBe(1);
    expect(ledger(store, 'search').units).toBe(100);
  });

  test('G2 search budget — sổ cạn: tick là skipped_quota và KHÔNG có trace event nào', async () => {
    const { store, trace, quota, loop } = await harness();
    store.upsertTopic({
      topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi', dailySearchBudget: 5,
    });
    store.upsertTopicKeyword({ topicId: 'fin', termKey: 'kw_a', displayTerm: 'lãi kép', relation: 'seed' });
    quota.consume('search.list', 100);
    expect(quota.remaining('search')).toBe(0);

    const result = await loop.runTick('fin');
    expect(result.status).toBe('skipped_quota');
    expect(trace.count('search.list')).toBe(0);
    expect(trace.events).toHaveLength(0);
  });
});

// ===========================================================================
// G3 restart idempotency — chết giữa bước search, khởi động lại
// ===========================================================================

describe('G3 restart idempotency', () => {
  test('G3 restart idempotency — chết sau keyword A (đã persist), trước B: không tick đôi, không search lại A', async () => {
    const root = await tempRoot('spy-hardgate-resume-');
    const dbPath = join(root, 'spy.sqlite');
    const day = quotaDay();
    const terms: Array<[string, string]> = [
      ['kw_a', 'lãi kép'], ['kw_b', 'nợ xấu'], ['kw_c', 'quỹ etf'],
    ];

    // ---- Runner #1: chết đúng tại checkpoint trước keyword thứ hai ----
    const store1 = new SpyStore(dbPath);
    openStores.push(store1);
    const quota1 = new QuotaLedger(store1);
    const trace1 = new TraceDataApi(quota1);
    const counting1 = new QuotaCountingDataApi(trace1, quota1, () => true);
    store1.upsertTopic({
      topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi', dailySearchBudget: 3,
    });
    for (const [key, term] of terms) {
      store1.upsertTopicKeyword({ topicId: 'fin', termKey: key, displayTerm: term, relation: 'seed' });
    }

    let died = false;
    const loop1 = new LoopRunner({
      store: store1, quota: quota1, dataRoot: root, dataApi: counting1,
      discovery: new DiscoveryService(store1, counting1, quota1),
      checkpoint: (name) => {
        // Chỉ chết ở keyword THỨ HAI: A đã trả về, quota + last_searched_at của A
        // đã ghi xuống đĩa; B chưa bắt đầu.
        if (name.startsWith('search:before-term:') && trace1.count('search.list') === 1) {
          died = true;
          throw new Error('process killed mid-search');
        }
      },
    });

    await expect(loop1.runTick('fin')).rejects.toThrow('process killed mid-search');
    expect(died).toBe(true);

    // Điều kiện của hợp đồng: A đã xong hẳn TRƯỚC khi chết.
    expect(trace1.count('search.list')).toBe(1);
    expect(ledger(store1, 'search').calls).toBe(1);
    const searchedA = store1.listTopicKeywords('fin').filter((k) => {
      const at = String(k['last_searched_at'] ?? '');
      return at !== '' && quotaDay(new Date(at)) === day;
    });
    expect(searchedA).toHaveLength(1);
    const termA = String(searchedA[0]!['term_key']);
    const tickAfterCrash = store1.getLastTick('fin')!;
    const originalTickId = String(tickAfterCrash['tick_id']);
    expect(String(tickAfterCrash['status'])).toBe('failed');
    store1.close();

    // ---- Runner #2: tiến trình mới, cùng DB, cùng topic/ngày ----
    const store2 = new SpyStore(dbPath);
    openStores.push(store2);
    const quota2 = new QuotaLedger(store2);
    const trace2 = new TraceDataApi(quota2);
    const counting2 = new QuotaCountingDataApi(trace2, quota2, () => true);
    const loop2 = new LoopRunner({
      store: store2, quota: quota2, dataRoot: root, dataApi: counting2,
      discovery: new DiscoveryService(store2, counting2, quota2),
    });

    const result2 = await loop2.runTick('fin');
    expect(result2.status).toBe('done');

    // 1. Đúng MỘT dòng loop_ticks cho (topic, quota_day) — không có dòng ma.
    const db = new Database(dbPath, { readonly: true });
    const tickCount = db.prepare(
      'SELECT count(*) AS n FROM loop_ticks WHERE topic_id=? AND quota_day=?',
    ).get('fin', day) as { n: number };
    expect(tickCount.n).toBe(1);

    // 2. Dòng đó giữ nguyên identity cũ và đạt một trạng thái kết thúc.
    const finalTick = db.prepare('SELECT * FROM loop_ticks WHERE topic_id=? AND quota_day=?')
      .get('fin', day) as Record<string, unknown>;
    expect(String(finalTick['tick_id'])).toBe(originalTickId);
    expect(String(finalTick['status'])).toBe('done');

    // 3. A search đúng một lần TRÊN CẢ HAI runner; B và C mỗi cái tối đa một lần.
    const combined = [...trace1.events, ...trace2.events]
      .filter((e) => e.endpoint === 'search.list')
      .map((e) => e.detail);
    expect(combined).toHaveLength(3);
    const displayA = terms.find(([key]) => key === termA)![1];
    expect(combined.filter((d) => d.includes(displayA))).toHaveLength(1);
    for (const [, term] of terms) {
      expect(combined.filter((d) => d.includes(term)).length).toBeLessThanOrEqual(1);
    }
    // Đúng ba term đã lên kế hoạch, không hơn không kém.
    expect(new Set(combined).size).toBe(3);

    // 4. Sổ search tổng cộng đúng 3 call — lần chạy lại không đốt thêm cho A.
    expect(ledger(store2, 'search').calls).toBe(3);

    // 5. Report dedupe key phát tối đa một lần.
    const reportCount = db.prepare(
      'SELECT count(*) AS n FROM daily_reports WHERE topic_id=? AND report_date=?',
    ).get('fin', day) as { n: number };
    expect(reportCount.n).toBe(1);
    db.close();
  });
});

// ===========================================================================
// G5 truthful output — không bịa số, hint không đội lốt verdict
// ===========================================================================

describe('G5 truthful output', () => {
  test('G5 truthful output — report P0 không hứa VPH/search volume/CTR/rank và gọi hint là phỏng đoán', async () => {
    const { store, trace, quota, loop } = await harness();
    store.upsertTopic({ topicId: 'fin', label: 'Tài chính cá nhân', market: 'vi', language: 'vi' });
    seedChannel(store, 'fin', 'UCtruth00000000000000001');
    // Kênh faceless rõ rệt trên chữ → hint cao, nhưng vẫn chỉ là phỏng đoán.
    trace.videoTitles = VI_TITLES;

    await loop.runTick('fin');

    const day = quotaDay();
    const reportRow = store.getDailyReportByDate('fin', day);
    expect(reportRow).not.toBeNull();
    const markdown = String(reportRow!['markdown']);
    const summaryRaw = String(reportRow!['summary_json']);
    const summary = JSON.parse(summaryRaw) as Record<string, unknown>;

    // Không có tuyên bố về nguồn số mà P0 KHÔNG có.
    for (const forbidden of [/VPH/i, /search volume/i, /\bCTR\b/i, /trend toàn cầu/i]) {
      expect(markdown).not.toMatch(forbidden);
      expect(summaryRaw).not.toMatch(forbidden);
    }
    // "rank": vị trí kết quả API không được gọi là rank ở bề mặt P0.
    expect(markdown).not.toMatch(/\brank\b/i);
    expect(summaryRaw).not.toMatch(/"rank"/i);

    // faceless: hint có method + reasons, KHÔNG phải verdict.
    const row = store.listTopicChannels('fin', {})[0]!;
    expect(row['faceless_score']).toBeNull();
    expect(row['faceless_hint']).not.toBeNull();
    const hintPayload = JSON.parse(String(row['faceless_hint_reasons_json'])) as {
      method: string; reasons: unknown[];
    };
    expect(['text_only', 'insufficient_sample']).toContain(hintPayload.method);
    expect(Array.isArray(hintPayload.reasons)).toBe(true);
    // Nếu report có nhắc faceless thì phải kèm nhãn phỏng đoán.
    if (/faceless/i.test(markdown)) {
      expect(markdown).toMatch(/đoán từ chữ/);
    }

    // Hint KHÔNG được gây auto-reject.
    expect(String(row['status'])).not.toBe('rejected');

    // Không bịa số khi không có nguồn: các trục chưa có dữ liệu để null, không phải 0 giả.
    const topLearn = (summary['topLearn'] ?? []) as Array<Record<string, unknown>>;
    for (const entry of topLearn) {
      expect(entry['facelessScore']).toBeNull();
      if (entry['medianViews'] === null) expect(entry['medianViewsVsOwn']).toBeNull();
    }

    // renderReport là một hàm duy nhất cho mọi bề mặt — chạy lại phải trùng khớp.
    const rebuilt = renderReport(JSON.parse(summaryRaw), { mode: 'tick' });
    expect(typeof rebuilt).toBe('string');
    expect(rebuilt).not.toMatch(/\bVPH\b/i);
    expect(quota).toBeDefined();
  });

  test('G5 truthful output — không có mẫu thì trả insufficient_sample/unavailable, không trả số bịa', async () => {
    const { store, quota } = await harness();
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi' });
    // Kênh chưa từng enrich: chưa có learn_value, chưa có hint.
    store.upsertTopicChannel({ topicId: 'fin', channelId: 'UCempty000000000000000001', status: 'new' });

    const day = quotaDay();
    const { summaryJson, markdown } = await buildDailyReport(store, quota, 'fin', day, {
      tickId: 'tick-g5', searchCallsUsed: 0, generalUnitsUsed: 0, keywordsSearched: [],
      newCandidates: 0, newShortlistedAuto: 0, autoRejected: 0, keywordsHarvested: 0,
    });
    const summary = JSON.parse(summaryJson) as Record<string, unknown>;

    // Kênh không có learn_value không được bịa điểm để lọt vào topLearn.
    expect(summary['topLearn']).toEqual([]);
    const row = store.listTopicChannels('fin', {})[0]!;
    expect(row['learn_value_score']).toBeNull();
    expect(row['faceless_hint']).toBeNull();
    expect(row['faceless_score']).toBeNull();

    for (const forbidden of [/VPH/i, /search volume/i, /\bCTR\b/i, /\brank\b/i]) {
      expect(markdown).not.toMatch(forbidden);
    }
  });
});

// ===========================================================================
// G7 language post-filter — loại kênh sai ngôn ngữ, và KHÔNG loại nhầm
// ===========================================================================

describe('G7 language post-filter', () => {
  test('G7 language post-filter — đa số defaultAudioLanguage=en trong topic vi → rejected, loop_auto, lang_mismatch', async () => {
    const { store, trace, loop } = await harness();
    store.upsertTopic({ topicId: 'fin', label: 'Tài chính', market: 'vi', language: 'vi' });
    // Ứng viên lọt vào dù relevanceLanguage=vi — đúng như hợp đồng mô tả:
    // relevanceLanguage chỉ nghiêng kết quả, không lọc.
    seedChannel(store, 'fin', 'UCenglish000000000000001');
    trace.videoTitles = EN_TITLES;
    trace.videoAudioLang = 'en-US';

    await loop.runTick('fin');

    const rejected = store.listTopicChannels('fin', { status: 'rejected' });
    expect(rejected).toHaveLength(1);
    const row = rejected[0]!;
    expect(String(row['channel_id'])).toBe('UCenglish000000000000001');
    expect(String(row['decided_by'])).toBe('loop_auto');
    expect(String(row['decided_reason'])).toBe('lang_mismatch');
    expect(String(row['lang_detected'])).toBe('en');

    // Lý do phải chỉ ra bằng chứng đến từ defaultAudioLanguage, không phải đoán.
    const evidence = JSON.parse(String(row['lang_evidence_json'])) as {
      method: string; evidenceField: string; declaredCount: number; sampleSize: number;
    };
    expect(evidence.method).toBe('declared_fields');
    expect(evidence.evidenceField).toBe('defaultAudioLanguage');
    expect(evidence.declaredCount).toBe(12);
    expect(evidence.sampleSize).toBe(12);

    // Nhìn thấy được: truy vấn ra bằng filter, không bị vứt âm thầm.
    expect(store.countTopicChannelsByStatus('fin')['rejected']).toBe(1);
    expect(store.listTopicChannels('fin', { status: 'new' })).toHaveLength(0);
  });

  test('G7 language post-filter — thiếu bằng chứng ngôn ngữ: KHÔNG auto-reject, vẫn chờ người duyệt', async () => {
    const { store, trace, loop } = await harness();
    store.upsertTopic({ topicId: 'fin', label: 'Tài chính', market: 'vi', language: 'vi' });
    seedChannel(store, 'fin', 'UCunknown000000000000001');
    // Không video nào khai defaultAudioLanguage; kênh khai country=VN/US đều không
    // được phép là căn cứ loại.
    trace.videoTitles = EN_TITLES;
    trace.videoAudioLang = null;

    await loop.runTick('fin');

    expect(store.listTopicChannels('fin', { status: 'rejected' })).toHaveLength(0);
    const stillNew = store.listTopicChannels('fin', { status: 'new' });
    expect(stillNew).toHaveLength(1);
    const row = stillNew[0]!;
    const evidence = JSON.parse(String(row['lang_evidence_json'])) as {
      method: string; evidenceField: string | null; declaredCount: number;
    };
    // Ghi lại phỏng đoán, nhưng nói rõ nó KHÔNG dựa trên trường khai báo.
    expect(evidence.method).toBe('title_heuristic');
    expect(evidence.evidenceField).toBeNull();
    expect(evidence.declaredCount).toBe(0);
    expect(row['lang_detected']).not.toBeNull();
    expect(String(row['decided_reason'] ?? '')).not.toBe('lang_mismatch');
  });

  test('G7 language post-filter — khai báo thưa dưới 50% không đủ để loại', async () => {
    const { store, loop, quota } = await harness();
    store.upsertTopic({ topicId: 'fin', label: 'Tài chính', market: 'vi', language: 'vi' });
    seedChannel(store, 'fin', 'UCsparse0000000000000001');

    // Ghi đè: chỉ 5/12 video khai 'en' (41%) — dưới ngưỡng 50%.
    const sparse = new (class extends TraceDataApi {
      override async fetchVideoStatistics(videoIds: readonly string[]): Promise<Map<string, VideoStatistics>> {
        const map = await super.fetchVideoStatistics(videoIds);
        let index = 0;
        for (const [key, value] of map) {
          map.set(key, { ...value, defaultAudioLanguage: index < 5 ? 'en' : null });
          index++;
        }
        return map;
      }
    })(quota);
    sparse.videoTitles = EN_TITLES;
    const counting = new QuotaCountingDataApi(sparse, quota, () => true);
    const sparseLoop = new LoopRunner({
      store, quota, dataApi: counting, dataRoot: '/tmp',
      discovery: new DiscoveryService(store, counting, quota),
    });

    await sparseLoop.runTick('fin');

    expect(store.listTopicChannels('fin', { status: 'rejected' })).toHaveLength(0);
    const row = store.listTopicChannels('fin', { status: 'new' })[0]!;
    const evidence = JSON.parse(String(row['lang_evidence_json'])) as {
      method: string; declaredCount: number; sampleSize: number;
    };
    expect(evidence.declaredCount).toBe(5);
    expect(evidence.sampleSize).toBe(12);
    expect(evidence.method).toBe('title_heuristic');
  });
});

// ===========================================================================
// Sửa theo repair note của codex — mỗi test khoá đúng một lỗi đã tìm thấy
// ===========================================================================

describe('G7 language post-filter — hoà và mẫu thiếu row (F1)', () => {
  test('G7 language post-filter — hoà 3 en / 3 vi KHÔNG reject, không công bố ngôn ngữ nào', () => {
    // Plurality "phần tử đầu thắng" từng cho ra majority='en' rồi loại một kênh
    // Việt hoàn toàn hợp lệ. Hoà thì không có kết luận.
    const videos = Array.from({ length: 6 }, (_, index) => ({
      title: index < 3 ? EN_TITLES[index]! : VI_TITLES[index]!,
      defaultAudioLanguage: index < 3 ? 'en' : 'vi',
    }));
    const verdict = evaluateChannelLanguage(videos, 'vi');
    expect(verdict.declaredCount).toBe(6);
    expect(verdict.decisive).toBe(false);
    expect(verdict.reject).toBe(false);
    expect(verdict.reason).toBeNull();
    expect(verdict.langDetected).toBeNull();
    expect(verdict.declaredCounts).toEqual({ en: 3, vi: 3 });
  });

  test('G7 language post-filter — plurality không quá bán (5 en/4 vi/3 fr) cũng KHÔNG reject', () => {
    const langs = [...Array(5).fill('en'), ...Array(4).fill('vi'), ...Array(3).fill('fr')];
    const videos = langs.map((lang, index) => ({
      title: `Video ${index}`, defaultAudioLanguage: lang as string,
    }));
    const verdict = evaluateChannelLanguage(videos, 'vi');
    // 5/12 không quá bán → không kết luận, dù 'en' là nhiều nhất.
    expect(verdict.decisive).toBe(false);
    expect(verdict.reject).toBe(false);
  });

  test('G7 language post-filter — quá bán thật (7/12 en) thì mới reject', () => {
    const langs = [...Array(7).fill('en'), ...Array(5).fill('vi')];
    const videos = langs.map((lang, index) => ({
      title: `Video ${index}`, defaultAudioLanguage: lang as string,
    }));
    const verdict = evaluateChannelLanguage(videos, 'vi');
    expect(verdict.decisive).toBe(true);
    expect(verdict.reject).toBe(true);
    expect(verdict.langDetected).toBe('en');
  });

  test('G7 language post-filter — videos.list trả thiếu row: mẫu số vẫn là 12, KHÔNG reject', async () => {
    const { store, quota, loop } = await harness();
    store.upsertTopic({ topicId: 'fin', label: 'Tài chính', market: 'vi', language: 'vi' });
    seedChannel(store, 'fin', 'UCpartial00000000000001');

    // 12 upload, nhưng videos.list chỉ trả về ĐÚNG MỘT row, và nó là tiếng Anh.
    // Trước sửa: mẫu = 1 → "100% khai báo, đa số en" → loại kênh Việt vĩnh viễn.
    const partial = new (class extends TraceDataApi {
      override async fetchVideoStatistics(videoIds: readonly string[]): Promise<Map<string, VideoStatistics>> {
        const full = await super.fetchVideoStatistics(videoIds);
        const only = new Map<string, VideoStatistics>();
        const firstKey = [...full.keys()][0];
        if (firstKey !== undefined) {
          only.set(firstKey, { ...full.get(firstKey)!, defaultAudioLanguage: 'en' });
        }
        return only;
      }
    })(quota);
    partial.videoTitles = VI_TITLES;
    const counting = new QuotaCountingDataApi(partial, quota, () => true);
    const partialLoop = new LoopRunner({
      store, quota, dataApi: counting, dataRoot: '/tmp',
      discovery: new DiscoveryService(store, counting, quota),
    });

    await partialLoop.runTick('fin');

    expect(store.listTopicChannels('fin', { status: 'rejected' })).toHaveLength(0);
    const row = store.listTopicChannels('fin', { status: 'new' })[0]!;
    const evidence = JSON.parse(String(row['lang_evidence_json'])) as {
      declaredCount: number; sampleSize: number; method: string;
    };
    // Mẫu số là toàn bộ slot đã chọn, không phải số row API trả về.
    expect(evidence.sampleSize).toBe(12);
    expect(evidence.declaredCount).toBe(1);
    expect(evidence.method).not.toBe('declared_fields');
    expect(loop).toBeDefined();
  });
});

describe('G1 quota ledger — counter của tick bám sổ thật (F2)', () => {
  test('G1 quota ledger — search LỖI vẫn được tính vào loop_ticks và report', async () => {
    const { store, trace, loop } = await harness();
    store.upsertTopic({
      topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi', dailySearchBudget: 3,
    });
    store.upsertTopicKeyword({ topicId: 'fin', termKey: 'kw_a', displayTerm: 'lãi kép', relation: 'seed' });
    // Request khởi phát rồi mới chết → decorator đã charge.
    trace.failOn = 'search.list';

    await loop.runTick('fin');

    const charged = ledger(store, 'search').calls;
    expect(charged).toBe(1);
    expect(trace.count('search.list')).toBe(1);

    // Counter đếm-khi-thành-công sẽ ghi 0 ở đây và báo cáo nói dối theo hướng
    // "còn ngân sách" — đúng hướng nguy hiểm nhất.
    const tick = store.getLastTick('fin')!;
    expect(Number(tick['search_calls_used'])).toBe(charged);

    const report = store.getDailyReportByDate('fin', quotaDay());
    const summary = JSON.parse(String(report!['summary_json'])) as {
      tick: { searchCallsUsed: number; generalUnitsUsed: number };
    };
    // Trường quota CỦA TICK trong report phải bằng đúng số đã charge.
    expect(summary.tick.searchCallsUsed).toBe(charged);
  });

  test('G1 quota ledger — general_units_used khớp đúng số unit đã charge, không phải ước lượng', async () => {
    const { store, trace, loop } = await harness();
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi' });
    seedChannel(store, 'fin', 'UCcount000000000000001');
    trace.videoTitles = VI_TITLES;

    await loop.runTick('fin');

    const generalCharged = ledger(store, 'general').units;
    const tracedGeneral = trace.events.filter((e) => EXPECTED_COST[e.endpoint]!.bucket === 'general');
    const expectedUnits = tracedGeneral.reduce((sum, e) => sum + EXPECTED_COST[e.endpoint]!.units, 0);
    expect(generalCharged).toBe(expectedUnits);

    const tick = store.getLastTick('fin')!;
    expect(Number(tick['general_units_used'])).toBe(generalCharged);

    const report = store.getDailyReportByDate('fin', quotaDay());
    const summary = JSON.parse(String(report!['summary_json'])) as {
      tick: { generalUnitsUsed: number };
    };
    expect(summary.tick.generalUnitsUsed).toBe(generalCharged);
  });

  test('G1 quota ledger — tick resume tính CẢ phần quota đã tiêu trước khi chết', async () => {
    const root = await tempRoot('spy-hardgate-resume-quota-');
    const dbPath = join(root, 'spy.sqlite');

    const store1 = new SpyStore(dbPath);
    openStores.push(store1);
    const quota1 = new QuotaLedger(store1);
    const trace1 = new TraceDataApi(quota1);
    const counting1 = new QuotaCountingDataApi(trace1, quota1, () => true);
    store1.upsertTopic({
      topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi', dailySearchBudget: 3,
    });
    const resumeTerms: Array<[string, string]> = [
      ['kw_a', 'lãi kép'], ['kw_b', 'nợ xấu'], ['kw_c', 'quỹ etf'],
    ];
    for (const [key, term] of resumeTerms) {
      store1.upsertTopicKeyword({ topicId: 'fin', termKey: key, displayTerm: term, relation: 'seed' });
    }
    const loop1 = new LoopRunner({
      store: store1, quota: quota1, dataRoot: root, dataApi: counting1,
      discovery: new DiscoveryService(store1, counting1, quota1),
      checkpoint: (name) => {
        if (name.startsWith('search:before-term:') && trace1.count('search.list') === 1) {
          throw new Error('killed after first search');
        }
      },
    });
    await expect(loop1.runTick('fin')).rejects.toThrow();
    const chargedBeforeCrash = ledger(store1, 'search').calls;
    expect(chargedBeforeCrash).toBe(1);
    store1.close();

    const store2 = new SpyStore(dbPath);
    openStores.push(store2);
    const quota2 = new QuotaLedger(store2);
    const trace2 = new TraceDataApi(quota2);
    const counting2 = new QuotaCountingDataApi(trace2, quota2, () => true);
    const loop2 = new LoopRunner({
      store: store2, quota: quota2, dataRoot: root, dataApi: counting2,
      discovery: new DiscoveryService(store2, counting2, quota2),
    });
    await loop2.runTick('fin');

    const totalCharged = ledger(store2, 'search').calls;
    expect(totalCharged).toBe(3);
    const tick = store2.getLastTick('fin')!;
    // Tick phải khai đủ 3, không phải 2 của riêng lần chạy sau.
    expect(Number(tick['search_calls_used'])).toBe(totalCharged);

    const report = store2.getDailyReportByDate('fin', quotaDay());
    const summary = JSON.parse(String(report!['summary_json'])) as {
      tick: { searchCallsUsed: number; generalUnitsUsed: number };
    };
    // Report của tick resume phải khai cả 3 call, không phải 2 của lần chạy sau.
    expect(summary.tick.searchCallsUsed).toBe(totalCharged);
  });
});

describe('G3 restart idempotency — report phải nằm trên đĩa trước khi tick done (F3)', () => {
  test('G3 restart idempotency — chết ở bước report rồi restart → đúng MỘT report, tick không kẹt done rỗng', async () => {
    const root = await tempRoot('spy-hardgate-report-crash-');
    const dbPath = join(root, 'spy.sqlite');
    const day = quotaDay();

    const store1 = new SpyStore(dbPath);
    openStores.push(store1);
    const quota1 = new QuotaLedger(store1);
    const trace1 = new TraceDataApi(quota1);
    const counting1 = new QuotaCountingDataApi(trace1, quota1, () => true);
    store1.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi' });
    seedChannel(store1, 'fin', 'UCreport00000000000001');
    trace1.videoTitles = VI_TITLES;

    const loop1 = new LoopRunner({
      store: store1, quota: quota1, dataRoot: root, dataApi: counting1,
      discovery: new DiscoveryService(store1, counting1, quota1),
      checkpoint: (name) => {
        // Chết SAU khi đã vào bước report, TRƯỚC khi report kịp ghi.
        if (name === 'report:before-persist') throw new Error('killed inside report step');
      },
    });
    await expect(loop1.runTick('fin')).rejects.toThrow('killed inside report step');

    // Tick KHÔNG được là 'done' khi chưa có report — nếu done, lần sau sẽ skip
    // và báo cáo mất vĩnh viễn.
    const crashed = store1.getLastTick('fin')!;
    expect(String(crashed['status'])).toBe('failed');
    expect(store1.getDailyReportByDate('fin', day)).toBeNull();
    store1.close();

    // Restart: phải resume được và sinh ra đúng một report.
    const store2 = new SpyStore(dbPath);
    openStores.push(store2);
    const quota2 = new QuotaLedger(store2);
    const trace2 = new TraceDataApi(quota2);
    const counting2 = new QuotaCountingDataApi(trace2, quota2, () => true);
    const loop2 = new LoopRunner({
      store: store2, quota: quota2, dataRoot: root, dataApi: counting2,
      discovery: new DiscoveryService(store2, counting2, quota2),
    });
    const result = await loop2.runTick('fin');
    expect(result.status).toBe('done');

    const db = new Database(dbPath, { readonly: true });
    const reports = db.prepare(
      'SELECT count(*) AS n FROM daily_reports WHERE topic_id=? AND report_date=?',
    ).get('fin', day) as { n: number };
    expect(reports.n).toBe(1);
    const ticks = db.prepare(
      'SELECT count(*) AS n FROM loop_ticks WHERE topic_id=? AND quota_day=?',
    ).get('fin', day) as { n: number };
    expect(ticks.n).toBe(1);
    db.close();
    expect(String(store2.getLastTick('fin')!['status'])).toBe('done');
  });

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

/** Ghi thẳng last_searched_at để dựng đúng khung giờ crossover. */
function setLastSearchedAt(dbPath: string, topicId: string, termKey: string, iso: string): void {
  const db = new Database(dbPath);
  db.prepare('UPDATE topic_keywords SET last_searched_at=?, status=? WHERE topic_id=? AND term_key=?')
    .run(iso, 'searched', topicId, termKey);
  db.close();
}

describe('T1 quota day — một loại "hôm nay" duy nhất (Pacific)', () => {
  test('T1 quota day — mốc UTC/Pacific: 2026-08-22T06:08Z thuộc quota-day 2026-08-21', () => {
    // Đây là cái bẫy, viết ra tường minh: lịch UTC đã sang ngày 22 trong khi
    // quota-day vẫn là 21. Mọi so sánh cắt chuỗi ISO đều sai đúng ở khung này.
    expect(quotaDay(new Date('2026-08-22T06:08:28.511Z'))).toBe('2026-08-21');
    expect(quotaDayOf('2026-08-22T06:08:28.511Z')).toBe('2026-08-21');
  });

  test('T1 quota day — restart trong khung crossover KHÔNG search lại keyword đã search', async () => {
    const root = await tempRoot('spy-t1-crossover-');
    const dbPath = join(root, 'spy.sqlite');
    const store = new SpyStore(dbPath);
    openStores.push(store);
    const quota = new QuotaLedger(store);
    const trace = new TraceDataApi(quota);
    const counting = new QuotaCountingDataApi(trace, quota, () => true);

    store.upsertTopic({
      topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi', dailySearchBudget: 3,
    });
    store.upsertTopicKeyword({ topicId: 'fin', termKey: 'kw_a', displayTerm: 'lãi kép', relation: 'seed' });
    store.upsertTopicKeyword({ topicId: 'fin', termKey: 'kw_b', displayTerm: 'nợ xấu', relation: 'seed' });

    // kw_a đã search lúc 06:08Z ngày 22 = 23:08 Pacific ngày 21.
    const searchedAt = '2026-08-22T06:08:00.000Z';
    setLastSearchedAt(dbPath, 'fin', 'kw_a', searchedAt);

    // Tick chạy lúc 06:30Z ngày 22 — VẪN cùng quota-day 2026-08-21.
    const now = new Date('2026-08-22T06:30:00.000Z');
    expect(quotaDay(now)).toBe('2026-08-21');
    expect(quotaDayOf(searchedAt)).toBe(quotaDay(now));

    const loop = new LoopRunner({
      store, quota, dataApi: counting, dataRoot: root,
      discovery: new DiscoveryService(store, counting, quota),
    });
    await loop.runTick('fin', { now });

    // kw_a KHÔNG được search lại; chỉ kw_b chạy.
    const searchedTerms = trace.events
      .filter((e) => e.endpoint === 'search.list')
      .map((e) => e.detail);
    expect(searchedTerms.filter((d) => d.includes('lãi kép'))).toHaveLength(0);
    expect(searchedTerms.filter((d) => d.includes('nợ xấu'))).toHaveLength(1);
    store.close();
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
  test('H2 quota ledger — tick topic thứ hai bị chặn khi topic thứ nhất đang chạy', async () => {
    const { store, trace, quota, loop } = await harness();
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi', dailySearchBudget: 2 });
    store.upsertTopic({ topicId: 'psy', label: 'Psych', market: 'vi', language: 'vi', dailySearchBudget: 2 });
    store.upsertTopicKeyword({ topicId: 'fin', termKey: 'kw_f', displayTerm: 'lãi kép', relation: 'seed' });
    store.upsertTopicKeyword({ topicId: 'psy', termKey: 'kw_p', displayTerm: 'tâm lý', relation: 'seed' });

    // Runner thứ hai dùng CHUNG store/ledger, đúng như hai topic trong một daemon.
    const otherLoop = new LoopRunner({
      store, quota, dataApi: counting0(store, quota, trace), dataRoot: '/tmp',
      discovery: new DiscoveryService(store, counting0(store, quota, trace), quota),
    });

    let blocked: unknown = null;
    // Chặn tick 'fin' ngay giữa bước search rồi thử tick 'psy' từ bên trong.
    const blockingLoop = new LoopRunner({
      store, quota, dataRoot: '/tmp',
      dataApi: counting0(store, quota, trace),
      discovery: new DiscoveryService(store, counting0(store, quota, trace), quota),
      checkpoint: async (name) => {
        if (name === 'search:start' && blocked === null) {
          blocked = await otherLoop.runTick('psy').catch((err: unknown) => err);
        }
      },
    });

    await blockingLoop.runTick('fin');

    // Tick thứ hai KHÔNG được chạy song song.
    expect(blocked).toBeInstanceOf(Error);
    expect((blocked as Error).message).toMatch(/tuần tự|song song/);
    // Và nó không để lại tick nào cho topic 'psy'.
    expect(store.getLastTick('psy')).toBeNull();
  });

  test('H2 quota ledger — chạy tuần tự thì mỗi tick chỉ khai phần của chính nó', async () => {
    const { store, trace, loop } = await harness();
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi', dailySearchBudget: 2 });
    store.upsertTopic({ topicId: 'psy', label: 'Psych', market: 'vi', language: 'vi', dailySearchBudget: 2 });
    store.upsertTopicKeyword({ topicId: 'fin', termKey: 'kw_f', displayTerm: 'lãi kép', relation: 'seed' });
    store.upsertTopicKeyword({ topicId: 'psy', termKey: 'kw_p', displayTerm: 'tâm lý', relation: 'seed' });

    await loop.runTick('fin');
    await loop.runTick('psy');

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
    seedChannel(store, 'fin', 'UCscope00000000000001');
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
