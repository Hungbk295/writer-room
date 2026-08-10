/**
 * Tests cho slice Discovery — xem plan/claude/spy-discovery-design.md.
 * Trọng tâm: quota gating (search 100/ngày, general 10.000/ngày), fit scoring
 * xác định, dedupe ứng viên, và corpus search khử trùng lặp snapshot.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SpyService, spyTools } from '../src/index.ts';
import { SpyStore } from '../src/store.ts';
import { QuotaLedger, QUOTA_LIMITS, quotaDay, nextQuotaReset } from '../src/quota.ts';
import { nicheConfigSchema, scoreChannelFit, buildQueryMatrix } from '../src/niche.ts';
import type {
  ChannelStatistics,
  SearchHit,
  SearchInput,
  VideoStatistics,
  YouTubeDataApiPort,
} from '../src/adapters/data-api.ts';
import type { VideoSnapshot } from '../src/schema.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Data API giả — đếm số lần gọi để kiểm chứng quota và dedupe. */
class FakeDataApi implements YouTubeDataApiPort {
  searchCalls: SearchInput[] = [];
  channelStatCalls: string[][] = [];
  featuredCalls: string[] = [];
  subscriptionCalls: string[] = [];
  /** channelId → danh sách featured; thiếu key = kênh không cấu hình section. */
  featured: Record<string, string[]> = {};
  /** channelId → subs, hoặc null để giả lập 403 (kênh ẩn subscriptions). */
  subscriptions: Record<string, string[] | null> = {};
  hitsPerSearch: SearchHit[] = [];

  async fetchVideoStatistics(): Promise<Map<string, VideoStatistics>> {
    return new Map();
  }

  async fetchChannelStatistics(channelIds: readonly string[]): Promise<Map<string, ChannelStatistics>> {
    this.channelStatCalls.push([...channelIds]);
    const map = new Map<string, ChannelStatistics>();
    channelIds.forEach((channelId, index) => {
      map.set(channelId, {
        channelId,
        title: `Kênh ${channelId}`,
        subscriberCount: 10_000 * (index + 1),
        videoCount: 120,
        viewCount: 5_000_000,
        uploadsPlaylistId: `UU${channelId.slice(2)}`,
      });
    });
    return map;
  }

  async search(input: SearchInput): Promise<{ hits: SearchHit[]; nextPageToken: string | null }> {
    this.searchCalls.push(input);
    return { hits: this.hitsPerSearch, nextPageToken: null };
  }

  async fetchFeaturedChannels(channelId: string): Promise<string[]> {
    this.featuredCalls.push(channelId);
    return this.featured[channelId] ?? [];
  }

  async fetchPublicSubscriptions(channelId: string): Promise<string[] | null> {
    this.subscriptionCalls.push(channelId);
    return this.subscriptions[channelId] ?? null;
  }
}

function hit(channelId: string, videoId: string): SearchHit {
  return {
    kind: 'video',
    videoId,
    channelId,
    title: `Video ${videoId} về vũ trụ`,
    description: 'giải thích khoa học',
    channelTitle: `Kênh ${channelId}`,
    publishedAt: '2026-06-01T00:00:00Z',
    thumbnailUrl: null,
  };
}

const NICHE = {
  version: 1 as const,
  markets: [
    { id: 'vi', label: 'VN', relevanceLanguage: 'vi', regionCode: 'VN', seedKeywords: ['vũ trụ', 'hiện sinh'] },
    { id: 'en', label: 'EN', relevanceLanguage: 'en', regionCode: 'US', seedKeywords: ['universe explained'] },
  ],
  negativeKeywords: ['reaction'],
  notes: 'test',
};

async function newSpy(dataApi?: YouTubeDataApiPort) {
  const root = await mkdtemp(join(tmpdir(), 'spy-disc-'));
  roots.push(root);
  const spy = new SpyService({ dataRoot: join(root, 'spy'), ...(dataApi ? { dataApi } : {}) });
  await spy.init();
  return spy;
}

async function spyWithNiche(dataApi: YouTubeDataApiPort) {
  const spy = await newSpy(dataApi);
  await spy.setNiche(NICHE);
  return spy;
}

describe('Quota ledger', () => {
  test('quotaDay theo Pacific và reset trỏ tới tương lai', () => {
    const day = quotaDay(new Date('2026-08-10T05:00:00Z'));
    // 05:00 UTC ngày 10 = 22:00 Pacific ngày 9 → vẫn là quota day 09.
    expect(day).toBe('2026-08-09');
    expect(Date.parse(nextQuotaReset(new Date('2026-08-10T05:00:00Z')))).toBeGreaterThan(
      Date.parse('2026-08-10T05:00:00Z'),
    );
  });

  test('hai bucket độc lập, đúng trần tài liệu Google', async () => {
    const spy = await newSpy();
    expect(QUOTA_LIMITS.search).toBe(100);
    expect(QUOTA_LIMITS.general).toBe(10_000);
    const ledger = new QuotaLedger(spy.store);
    ledger.consume('search.list');
    expect(ledger.remaining('search')).toBe(99);
    // Tiêu search KHÔNG làm hụt bucket general.
    expect(ledger.remaining('general')).toBe(10_000);
    ledger.consume('channels.list');
    expect(ledger.remaining('general')).toBe(9_999);
  });

  test('vượt trần thì ném quota_exceeded TRƯỚC khi gọi API', async () => {
    const spy = await newSpy();
    const ledger = new QuotaLedger(spy.store);
    for (let i = 0; i < 100; i += 1) ledger.consume('search.list');
    expect(ledger.remaining('search')).toBe(0);
    expect(() => ledger.consume('search.list')).toThrow(/Hết quota bucket "search"/);
    expect(ledger.canAfford('search.list')).toBe(false);
    // general vẫn dùng được bình thường.
    expect(ledger.canAfford('channels.list', 100)).toBe(true);
  });
});

describe('Niche config + fit scoring', () => {
  test('schema điền default và từ chối field lạ', () => {
    const parsed = nicheConfigSchema.parse(NICHE);
    expect(parsed.scoring.keywordOverlap).toBe(40);
    expect(parsed.format.videoDuration).toBe('any');
    expect(() => nicheConfigSchema.parse({ ...NICHE, khongTonTai: 1 })).toThrow();
  });

  test('khớp seed keyword được điểm, dính negative bị phạt', () => {
    const niche = nicheConfigSchema.parse(NICHE);
    const market = niche.markets[0]!;
    const good = scoreChannelFit(
      { channelId: 'UC_a', title: 'Vũ trụ giải thích', subscriberCount: 50_000, videoCount: 100, viewCount: 10_000_000 },
      niche, market,
    );
    const bad = scoreChannelFit(
      { channelId: 'UC_b', title: 'reaction vũ trụ', subscriberCount: 50_000, videoCount: 100, viewCount: 10_000_000 },
      niche, market,
    );
    expect(good.score).toBeGreaterThan(bad.score);
    expect(bad.reasons.some((r) => r.factor === 'negativeKeywords')).toBe(true);
    // Mọi điểm đều có lý do kèm theo — không có con số không giải thích được.
    expect(good.reasons.every((r) => r.detail.length > 0)).toBe(true);
  });

  test('channelFilter loại kênh ngoài dải và nêu lý do', () => {
    const niche = nicheConfigSchema.parse({
      ...NICHE,
      channelFilter: { minSubscribers: 1_000, maxSubscribers: 100_000, minVideos: 10 },
    });
    const tooBig = scoreChannelFit({ channelId: 'UC_x', title: 'vũ trụ', subscriberCount: 9_000_000 }, niche, niche.markets[0]);
    expect(tooBig.excluded).toBe(true);
    expect(tooBig.excludeReason).toContain('trên ngưỡng');
    expect(tooBig.score).toBe(0);
  });

  test('buildQueryMatrix nhân keyword × order và cắt theo maxQueries', () => {
    const niche = nicheConfigSchema.parse(NICHE);
    const all = buildQueryMatrix(niche.markets[0]!, { orders: ['relevance', 'viewCount'] });
    expect(all).toHaveLength(4);
    expect(buildQueryMatrix(niche.markets[0]!, { maxQueries: 3 })).toHaveLength(3);
  });
});

describe('spy_discover_channels', () => {
  test('dry_run báo kế hoạch và KHÔNG tiêu quota, không gọi API', async () => {
    const api = new FakeDataApi();
    const spy = await spyWithNiche(api);
    const result = await spy.discoverChannels({ maxQueries: 4, dryRun: true }) as {
      dryRun: boolean; estimatedSearchCalls: number; affordable: boolean;
    };
    expect(result.dryRun).toBe(true);
    expect(result.estimatedSearchCalls).toBeGreaterThan(0);
    expect(result.affordable).toBe(true);
    expect(api.searchCalls).toHaveLength(0);
    expect(spy.quota.remaining('search')).toBe(100);
  });

  test('chạy thật: tiêu đúng số search call, tạo ứng viên, enrich theo lô', async () => {
    const api = new FakeDataApi();
    api.hitsPerSearch = [hit('UCaaaaaaaaaaaaaaaaaaaaaa', 'v1'), hit('UCbbbbbbbbbbbbbbbbbbbbbb', 'v2')];
    const spy = await spyWithNiche(api);

    const result = await spy.discoverChannels({ maxQueries: 2, marketId: 'vi' }) as {
      searchCallsUsed: number; created: number; uniqueChannelsFound: number; enrichUnits: number;
    };
    expect(result.searchCallsUsed).toBe(2);
    expect(result.uniqueChannelsFound).toBe(2);
    expect(result.created).toBe(2);
    expect(result.enrichUnits).toBe(1); // 2 kênh gói trong 1 lô channels.list
    expect(spy.quota.remaining('search')).toBe(98);
    expect(spy.quota.remaining('general')).toBe(9_999);

    // Tham số market được truyền đúng xuống search.list.
    expect(api.searchCalls[0]?.regionCode).toBe('VN');
    expect(api.searchCalls[0]?.relevanceLanguage).toBe('vi');
    expect(api.searchCalls[0]?.type).toBe('video');
  });

  test('lần chạy sau không enrich lại kênh đã biết', async () => {
    const api = new FakeDataApi();
    api.hitsPerSearch = [hit('UCaaaaaaaaaaaaaaaaaaaaaa', 'v1')];
    const spy = await spyWithNiche(api);
    await spy.discoverChannels({ maxQueries: 1, marketId: 'vi' });
    const enrichCallsAfterFirst = api.channelStatCalls.length;

    const second = await spy.discoverChannels({ maxQueries: 1, marketId: 'vi' }) as {
      created: number; skippedKnown: number; enrichUnits: number;
    };
    expect(second.created).toBe(0);
    expect(second.skippedKnown).toBe(1);
    expect(second.enrichUnits).toBe(0);
    expect(api.channelStatCalls).toHaveLength(enrichCallsAfterFirst);
  });

  test('hết quota search thì chặn, không gọi API', async () => {
    const api = new FakeDataApi();
    api.hitsPerSearch = [hit('UCaaaaaaaaaaaaaaaaaaaaaa', 'v1')];
    const spy = await spyWithNiche(api);
    for (let i = 0; i < 100; i += 1) spy.quota.consume('search.list');
    await expect(spy.discoverChannels({ maxQueries: 1, marketId: 'vi' })).rejects.toMatchObject({
      code: 'quota_exceeded',
    });
    expect(api.searchCalls).toHaveLength(0);
  });

  test('niche chưa có seedKeywords thì báo lỗi rõ ràng', async () => {
    const api = new FakeDataApi();
    const spy = await newSpy(api);
    await spy.setNiche({ ...NICHE, markets: NICHE.markets.map((m) => ({ ...m, seedKeywords: [] })) });
    await expect(spy.discoverChannels({ maxQueries: 2 })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  test('chưa có niche.json thì trả template và chặn discovery', async () => {
    const api = new FakeDataApi();
    const spy = await newSpy(api);
    const niche = await spy.getNiche();
    expect(niche.exists).toBe(false);
    expect(niche.config.markets).toHaveLength(2);
    await expect(spy.discoverChannels({ maxQueries: 1 })).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('spy_expand_graph', () => {
  test('featured channels: 1 unit/kênh gốc, không đụng bucket search', async () => {
    const api = new FakeDataApi();
    api.featured = { UCseed0000000000000000000: ['UCfeat111111111111111111', 'UCfeat222222222222222222'] };
    const spy = await spyWithNiche(api);

    const result = await spy.expandGraph({ channelIds: ['UCseed0000000000000000000'] }) as {
      uniqueChannelsFound: number; created: number; perSeed: Array<{ featured: number; subscriptions: number | null }>;
    };
    expect(result.uniqueChannelsFound).toBe(2);
    expect(result.created).toBe(2);
    expect(result.perSeed[0]?.featured).toBe(2);
    expect(spy.quota.remaining('search')).toBe(100);
    // 1 channelSections + 1 channels.list enrich
    expect(spy.quota.remaining('general')).toBe(9_998);
  });

  test('kênh ẩn subscriptions (403 → null) không bị coi là lỗi', async () => {
    const api = new FakeDataApi();
    api.featured = { UCseed0000000000000000000: [] };
    api.subscriptions = { UCseed0000000000000000000: null };
    const spy = await spyWithNiche(api);
    const result = await spy.expandGraph({
      channelIds: ['UCseed0000000000000000000'],
      includeSubscriptions: true,
    }) as { perSeed: Array<{ subscriptions: number | null }>; uniqueChannelsFound: number };
    expect(result.perSeed[0]?.subscriptions).toBeNull();
    expect(result.uniqueChannelsFound).toBe(0);
  });

  test('không có kênh gốc nào thì báo lỗi thay vì chạy rỗng', async () => {
    const api = new FakeDataApi();
    const spy = await spyWithNiche(api);
    await expect(spy.expandGraph({})).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('Candidates', () => {
  test('kênh đã reject không bị discovery sau đưa về lại new', async () => {
    const api = new FakeDataApi();
    api.hitsPerSearch = [hit('UCaaaaaaaaaaaaaaaaaaaaaa', 'v1')];
    const spy = await spyWithNiche(api);
    await spy.discoverChannels({ maxQueries: 1, marketId: 'vi' });
    spy.decideCandidates(['UCaaaaaaaaaaaaaaaaaaaaaa'], 'rejected');

    await spy.discoverChannels({ maxQueries: 1, marketId: 'vi' });
    const listed = spy.listCandidates({ status: 'rejected' });
    expect(listed.candidates.map((c) => c.channelId)).toEqual(['UCaaaaaaaaaaaaaaaaaaaaaa']);
  });

  test('list lọc theo fit và trả đếm theo trạng thái', async () => {
    const api = new FakeDataApi();
    api.hitsPerSearch = [hit('UCaaaaaaaaaaaaaaaaaaaaaa', 'v1'), hit('UCbbbbbbbbbbbbbbbbbbbbbb', 'v2')];
    const spy = await spyWithNiche(api);
    await spy.discoverChannels({ maxQueries: 1, marketId: 'vi' });
    spy.decideCandidates(['UCaaaaaaaaaaaaaaaaaaaaaa'], 'shortlisted');

    const all = spy.listCandidates({});
    expect(all.byStatus['shortlisted']).toBe(1);
    expect(all.byStatus['new']).toBe(1);
    expect(spy.listCandidates({ minFitScore: 999 }).count).toBe(0);
  });

  test('scan_candidates dry_run ước tính đúng ~21 unit cho 500 video', async () => {
    const api = new FakeDataApi();
    const spy = await spyWithNiche(api);
    const result = await spy.scanCandidates({
      channelIds: ['UCaaaaaaaaaaaaaaaaaaaaaa'],
      scanLimit: 500,
      dryRun: true,
    }) as { unitsPerChannel: number; estimatedUnits: number; affordable: boolean };
    expect(result.unitsPerChannel).toBe(21);
    expect(result.estimatedUnits).toBe(21);
    expect(result.affordable).toBe(true);
  });

  test('scan_candidates chặn khi quota general không đủ', async () => {
    const api = new FakeDataApi();
    const spy = await spyWithNiche(api);
    // Đốt gần hết bucket general.
    spy.store.addQuotaUsage('general', quotaDay(), 9_995, 1);
    await expect(spy.scanCandidates({
      channelIds: ['UCaaaaaaaaaaaaaaaaaaaaaa'],
      scanLimit: 500,
    })).rejects.toMatchObject({ code: 'quota_exceeded' });
  });
});

describe('Corpus search — 0 quota', () => {
  function seedVideo(store: SpyStore, runId: string, sourceVideoId: string, overrides: Partial<VideoSnapshot> = {}) {
    store.insertVideoSnapshot({
      id: randomUUID(),
      spyRunId: runId,
      sourceVideoId,
      canonicalUrl: `https://www.youtube.com/watch?v=${sourceVideoId}`,
      title: 'Vũ trụ có vô hạn không',
      channelTitle: 'Kênh test',
      rank: 1,
      viewCount: 1_000,
      likeCount: 100,
      commentCount: 10,
      durationSec: 600,
      publishedAt: '2026-01-01T00:00:00.000Z',
      tags: [],
      transcriptStatus: 'ok',
      transcriptSource: 'manual',
      frameStatus: 'skipped',
      thumbnail: null,
      createdAt: new Date().toISOString(),
      ...overrides,
    } as VideoSnapshot);
  }

  function seedRun(store: SpyStore, sourceIdentity: string, key: string) {
    const op = store.createOrGetOperation({
      kind: 'acquire_channel', ownerSubject: 'test', idempotencyKey: key, request: {},
    });
    return store.createSpyRun({
      operationId: op.operation.id,
      kind: 'channel',
      canonicalSource: `https://www.youtube.com/channel/${sourceIdentity}`,
      sourceIdentity,
      config: {},
    });
  }

  test('cùng một video quét hai lần chỉ trả bản mới nhất', async () => {
    const spy = await newSpy();
    const runOld = seedRun(spy.store, 'UC_corpus', 'run-old');
    const runNew = seedRun(spy.store, 'UC_corpus', 'run-new');
    seedVideo(spy.store, runOld.id, 'VID11111111', { viewCount: 1_000, createdAt: '2026-01-01T00:00:00.000Z' });
    seedVideo(spy.store, runNew.id, 'VID11111111', { viewCount: 9_000, createdAt: '2026-08-01T00:00:00.000Z' });

    const result = spy.corpusVideos({});
    expect(result.count).toBe(1);
    expect(result.videos[0]?.viewCount).toBe(9_000);
  });

  test('tìm xuyên nhiều kênh, lọc và sắp xếp', async () => {
    const spy = await newSpy();
    const runA = seedRun(spy.store, 'UC_aaa', 'run-a');
    const runB = seedRun(spy.store, 'UC_bbb', 'run-b');
    seedVideo(spy.store, runA.id, 'VIDaaaaaaaa', { viewCount: 5_000, title: 'Hố đen là gì' });
    seedVideo(spy.store, runB.id, 'VIDbbbbbbbb', { viewCount: 50_000, title: 'Vũ trụ giãn nở' });

    const byViews = spy.corpusVideos({ orderBy: 'views' });
    expect(byViews.videos.map((v) => v.sourceVideoId)).toEqual(['VIDbbbbbbbb', 'VIDaaaaaaaa']);
    expect(new Set(byViews.videos.map((v) => v.channelKey))).toEqual(new Set(['UC_aaa', 'UC_bbb']));

    expect(spy.corpusVideos({ titleQuery: 'hố đen' }).count).toBe(1);
    expect(spy.corpusVideos({ minViews: 10_000 }).count).toBe(1);
    expect(spy.corpusVideos({ channelIds: ['UC_aaa'] }).count).toBe(1);
    expect(spy.corpusVideos({ maxDurationSec: 100 }).count).toBe(0);
  });

  test('lọc theo channelId thật vẫn khớp dù sourceIdentity bị viết thường', async () => {
    const spy = await newSpy();
    // Đúng dạng canonical hoá thật của spy: 'youtube:channel:/channel/<lowercase id>'.
    const run = seedRun(spy.store, 'youtube:channel:/channel/ucaaaaaaaaaaaaaaaaaaaaaa', 'run-case');
    seedVideo(spy.store, run.id, 'VIDcase1111');

    expect(spy.corpusVideos({ channelIds: ['UCaaaaaaaaaaaaaaaaaaaaaa'] }).count).toBe(1);
    expect(spy.corpusVideos({ channelIds: ['UCzzzzzzzzzzzzzzzzzzzzzz'] }).count).toBe(0);
  });

  test('transcript_query không khớp gì thì trả rỗng kèm ghi chú, không trả toàn bộ corpus', async () => {
    const spy = await newSpy();
    const run = seedRun(spy.store, 'UC_tq', 'run-tq');
    seedVideo(spy.store, run.id, 'VIDtq111111');
    const result = spy.corpusVideos({ transcriptQuery: 'khongcotutnaykhopca' });
    expect(result.count).toBe(0);
    expect(result.videos).toHaveLength(0);
  });

  test('thống kê kênh tính trên snapshot mới nhất', async () => {
    const spy = await newSpy();
    const run = seedRun(spy.store, 'UC_stats', 'run-stats');
    seedVideo(spy.store, run.id, 'VIDsss11111', { viewCount: 1_000 });
    seedVideo(spy.store, run.id, 'VIDsss22222', { viewCount: 3_000 });

    const channels = spy.corpusChannels({});
    expect(channels.count).toBe(1);
    expect(channels.channels[0]?.videoCount).toBe(2);
    expect(channels.channels[0]?.avgViews).toBe(2_000);
    expect(channels.channels[0]?.withTranscript).toBe(2);
  });
});

describe('Đăng ký tool', () => {
  test('12 tool discovery mới đều có mặt', async () => {
    const spy = await newSpy();
    const names = spyTools(spy).map((tool) => tool.name);
    for (const expected of [
      'spy_quota_status', 'spy_niche_get', 'spy_niche_set', 'spy_niche_score_fit',
      'spy_discover_channels', 'spy_discover_videos', 'spy_expand_graph',
      'spy_candidates_list', 'spy_candidates_decide', 'spy_scan_candidates',
      'spy_corpus_videos', 'spy_corpus_channels',
    ]) {
      expect(names).toContain(expected);
    }
  });

  test('quota_status nói rõ đây là ước lượng phía client', async () => {
    const spy = await newSpy();
    const status = spy.quotaStatus();
    expect(status.note).toContain('Ước lượng');
    expect(status.buckets.map((b) => b.bucket).sort()).toEqual(['general', 'search']);
  });
});
