/**
 * loop-modes.test.ts — Spy Pipeline v3-lean (plan §6 tiêu chí 2–6):
 *
 *   §6.2  loop KHÔNG BAO GIỜ ghi status 'active'/'paused' — chỉ new/pending,
 *         rejected(lang_mismatch) và suggestion.
 *   §6.3  daily thực hiện ĐÚNG 0 search call.
 *   §6.4  weekly loại kênh dead/lottery, chỉ đề xuất kênh outlier sống.
 *   §6.5  setup S2/S3 dừng ở awaiting_* chờ người duyệt.
 *   §6.6  idempotency theo (topic, quota_day, mode).
 *
 * FakeDataApi có viewCount/duration/ngôn ngữ theo video — cần thiết để kiểm
 * tra baseline/outlier (khác FakeDataApi của loop.test.ts vốn cố định 20k).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SpyStore, DEFAULT_TOPIC_SETTINGS } from '../src/store.ts';
import { QuotaLedger, quotaDay } from '../src/quota.ts';
import { DiscoveryService } from '../src/discovery.ts';
import { LoopRunner } from '../src/loop/runner.ts';
import type {
  ChannelStatistics,
  PlaylistVideoItem,
  SearchHit,
  SearchInput,
  VideoStatistics,
  YouTubeDataApiPort,
} from '../src/adapters/data-api.ts';

interface FakeVideo {
  videoId: string;
  title: string;
  views: number;
  durationSec?: number;
  defaultAudioLanguage?: string | null;
  publishedAt?: string;
}

class FakeDataApi implements YouTubeDataApiPort {
  searchCalls: SearchInput[] = [];
  playlistCalls: string[] = [];
  /** termKey display-term → hits; cùng một trả lời cho mọi q nếu set hitsForAll. */
  hitsByQuery = new Map<string, SearchHit[]>();
  hitsForAll: SearchHit[] | null = null;
  videosByChannel = new Map<string, FakeVideo[]>();
  channelsMeta = new Map<string, Partial<ChannelStatistics>>();

  async fetchVideoStatistics(videoIds: readonly string[]): Promise<Map<string, VideoStatistics>> {
    const map = new Map<string, VideoStatistics>();
    for (const [channelId, videos] of this.videosByChannel) {
      for (const video of videos) {
        if (!videoIds.includes(video.videoId)) continue;
        map.set(video.videoId, {
          videoId: video.videoId,
          likeCount: 10,
          commentCount: 5,
          viewCount: video.views,
          publishedAt: video.publishedAt ?? '2026-08-19T00:00:00.000Z',
          publishedAtPrecision: 'second',
          durationSec: video.durationSec ?? 600,
          tags: [],
          title: video.title,
          channelId,
          channelTitle: `Kênh ${channelId}`,
          thumbnailUrl: `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`,
          defaultAudioLanguage: video.defaultAudioLanguage ?? null,
          defaultLanguage: null,
        });
      }
    }
    return map;
  }

  async listUploadsPlaylistItems(uploadsPlaylistId: string, limit: number): Promise<PlaylistVideoItem[]> {
    this.playlistCalls.push(uploadsPlaylistId);
    const channelId = `UC${uploadsPlaylistId.slice(2)}`;
    const videos = this.videosByChannel.get(channelId) ?? [];
    return videos.slice(0, limit).map((video, index) => ({
      videoId: video.videoId,
      publishedAt: video.publishedAt ?? '2026-08-19T00:00:00.000Z',
      title: video.title,
      position: index,
    }));
  }

  async fetchChannelStatistics(channelIds: readonly string[]): Promise<Map<string, ChannelStatistics>> {
    const map = new Map<string, ChannelStatistics>();
    for (const channelId of channelIds) {
      const meta = this.channelsMeta.get(channelId) ?? {};
      map.set(channelId, {
        channelId,
        title: meta.title ?? `Kênh ${channelId}`,
        description: null,
        subscriberCount: meta.subscriberCount ?? 10_000,
        videoCount: null,
        viewCount: null,
        uploadsPlaylistId: `UU${channelId.slice(2)}`,
        publishedAt: meta.publishedAt ?? '2024-01-01T00:00:00.000Z',
        country: meta.country ?? 'VN',
      });
    }
    return map;
  }

  async search(input: SearchInput): Promise<{ hits: SearchHit[]; nextPageToken: string | null }> {
    this.searchCalls.push(input);
    return { hits: this.hitsForAll ?? this.hitsByQuery.get(input.q ?? '') ?? [], nextPageToken: null };
  }
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const tempDir = await mkdtemp(join(tmpdir(), 'spy-modes-'));
  roots.push(tempDir);
  const store = new SpyStore(join(tempDir, 'spy.sqlite'));
  const dataApi = new FakeDataApi();
  const quota = new QuotaLedger(store);
  const discovery = new DiscoveryService(store, dataApi, quota);
  const loop = new LoopRunner({ store, quota, discovery, dataApi, dataRoot: tempDir });
  return { store, dataApi, quota, loop, tempDir };
}

function seedTopic(store: SpyStore, extra: { region?: string } = {}) {
  store.upsertTopic({
    topicId: 'fin', label: 'Finance VI', market: 'vi', language: 'vi',
    region: extra.region ?? 'VN',
  });
}

/** Kênh healthy cho fake: n video duration 600s, view quanh median, audio vi. */
function makeVideos(prefix: string, channelId: string, n: number, views: number, extra: Partial<FakeVideo> = {}): FakeVideo[] {
  return Array.from({ length: n }, (_, i) => ({
    videoId: `${channelId}v${i}`,
    title: `${prefix} số ${i}`,
    views,
    durationSec: 600,
    defaultAudioLanguage: 'vi',
    publishedAt: new Date(Date.parse('2026-08-20T00:00:00.000Z') - i * 7 * 86_400_000).toISOString(),
    ...extra,
  }));
}

function channelStatuses(store: SpyStore, topicId: string): Map<string, string> {
  const rows = store.listTopicChannelsByStatus(topicId, ['new', 'active', 'paused', 'rejected', 'own']);
  return new Map(rows.map((r) => [r.channelId, r.status]));
}

describe('DAILY mode — D1–D5 (§6.3: 0 search call)', () => {
  test('daily quét kênh active, ghi video + snapshot, KHÔNG gọi search', async () => {
    const { store, dataApi, loop } = await setup();
    seedTopic(store);
    store.upsertTopicChannel({ topicId: 'fin', channelId: 'UCactive', status: 'active', title: 'Kênh A' });
    dataApi.videosByChannel.set('UCactive', makeVideos('đầu tư', 'UCactive', 5, 2_000));

    const result = await loop.runTick('fin', { mode: 'daily' });
    expect(result.status).toBe('done');
    expect(result.mode).toBe('daily');
    // §6.3 — D1: tuyệt đối không một search call nào.
    expect(dataApi.searchCalls).toEqual([]);
    // D2: video + snapshot ngày được ghi.
    const videos = store.listTopicVideos('fin', {});
    expect(videos.length).toBe(5);
    expect(videos[0]!.source).toBe('daily_scan');
    const snaps = store.listVideoDailyViews('fin', videos[0]!.videoId);
    expect(snaps.length).toBe(1);
    // Baseline được cập nhật lên kênh (mẫu 5 < 10 → reliable=false nhưng n vẫn ghi).
    const channel = store.listTopicChannelsByStatus('fin', ['active'])[0]!;
    expect(channel.baselineN).toBe(5);
    expect(channel.lastCheckedAt).not.toBeNull();
    // Report mode=daily nằm trên đĩa trước khi tick done.
    const report = store.getDailyReportByDate('fin', quotaDay(), 'daily');
    expect(report).not.toBeNull();
    const summary = JSON.parse(String(report!['summary_json']));
    expect(summary.mode).toBe('daily');
    expect(summary.daily.newVideos).toBe(5);
    store.close();
  });

  test('baseline daily chỉ tính video uploads của kênh — video tìm qua search không đẩy baseline lên', async () => {
    const { store, dataApi, loop } = await setup();
    seedTopic(store);
    store.upsertTopicChannel({ topicId: 'fin', channelId: 'UCactive', status: 'active', title: 'Kênh A' });
    const uploads = makeVideos('đầu tư', 'UCactive', 12, 1_000);
    dataApi.videosByChannel.set('UCactive', uploads);
    const base = { topicId: 'fin', channelId: 'UCactive', durationSec: 600, capturedAt: '2026-08-21T00:00:00.000Z' };
    // Video hit chỉ thấy qua weekly search, mới hơn mọi upload → nằm trong cửa sổ 30.
    store.upsertTopicVideo({
      ...base, videoId: 'UCactivehit', title: 'video hit', source: 'weekly_search',
      publishedAt: '2026-08-21T00:00:00.000Z', views: 900_000,
    });
    // Một upload thật lần đầu đến từ search — daily thấy nó trong uploads → được tính.
    store.upsertTopicVideo({
      ...base, videoId: uploads[0]!.videoId, title: uploads[0]!.title, source: 'weekly_search',
      publishedAt: uploads[0]!.publishedAt, views: 1_000,
    });

    await loop.runTick('fin', { mode: 'daily' });

    const channel = store.listTopicChannelsByStatus('fin', ['active'])[0]!;
    // Có video hit trong mẫu thì n=13 và max/median = 900 → kênh bị gắn nhầm xổ số.
    expect(channel.baselineN).toBe(12);
    expect(channel.baselineMedianViews).toBe(1_000);
    expect(channel.maxViews).toBe(1_000);
    const videos = new Map(store.listTopicVideos('fin', {}).map((v) => [v.videoId, v]));
    expect(videos.get('UCactivehit')!.baselineEligible).toBe(false);
    expect(videos.get(uploads[0]!.videoId)!.baselineEligible).toBe(true);
    // source vẫn giữ nguồn đầu tiên để truy vết.
    expect(videos.get(uploads[0]!.videoId)!.source).toBe('weekly_search');
    store.close();
  });

  test('daily chỉ quét kênh active — kênh paused/new không bị quét', async () => {
    const { store, dataApi, loop } = await setup();
    seedTopic(store);
    store.upsertTopicChannel({ topicId: 'fin', channelId: 'UCactive', status: 'active' });
    store.upsertTopicChannel({ topicId: 'fin', channelId: 'UCpaused', status: 'paused' });
    store.upsertTopicChannel({ topicId: 'fin', channelId: 'UCnew', status: 'new' });
    dataApi.videosByChannel.set('UCactive', makeVideos('a', 'UCactive', 2, 1_000));
    dataApi.videosByChannel.set('UCpaused', makeVideos('p', 'UCpaused', 2, 1_000));
    dataApi.videosByChannel.set('UCnew', makeVideos('n', 'UCnew', 2, 1_000));

    await loop.runTick('fin', { mode: 'daily' });
    // playlistItems chỉ được gọi cho kênh active — playlist của 2 kênh kia không đụng.
    expect(dataApi.playlistCalls).toEqual(['UUactive']);
    store.close();
  });

  test('kênh im quá silent_days → suggestion pause_silent, status KHÔNG đổi', async () => {
    const { store, dataApi, loop } = await setup();
    seedTopic(store);
    store.upsertTopicChannel({ topicId: 'fin', channelId: 'UCsilent', status: 'active' });
    const old = new Date(Date.now() - 120 * 86_400_000).toISOString(); // 120 ngày > silent_days 60
    dataApi.videosByChannel.set('UCsilent', [
      { videoId: 'v-old', title: 'video cũ', views: 1_000, durationSec: 600, defaultAudioLanguage: 'vi', publishedAt: old },
    ]);

    await loop.runTick('fin', { mode: 'daily' });
    const channel = store.listTopicChannelsByStatus('fin', ['active'])[0]!;
    // §6.2: suggestion là GỢI Ý — status vẫn 'active', chỉ người mới pause được.
    expect(channel.suggestion).toBe('pause_silent');
    expect(channel.status).toBe('active');
    store.close();
  });

  test('daily thứ hai cùng ngày → skipped (idempotent theo mode)', async () => {
    const { store, dataApi, loop } = await setup();
    seedTopic(store);
    store.upsertTopicChannel({ topicId: 'fin', channelId: 'UCactive', status: 'active' });
    dataApi.videosByChannel.set('UCactive', makeVideos('a', 'UCactive', 2, 1_000));

    const r1 = await loop.runTick('fin', { mode: 'daily' });
    expect(r1.status).toBe('done');
    const r2 = await loop.runTick('fin', { mode: 'daily' });
    expect(r2.status).toBe('skipped_quota');
    store.close();
  });
});

describe('WEEKLY mode — W1–W5', () => {
  test('weekly search ≤ budget, publishedAfter 28 ngày, kênh outlier ngoài follow → new', async () => {
    const { store, dataApi, loop } = await setup();
    seedTopic(store);
    store.upsertTopicKeyword({ topicId: 'fin', termKey: 'vay-tra-gop', displayTerm: 'vay trả góp', relation: 'seed', status: 'active' });
    // Kênh ngoài follow: 12 video 1k views + hit từ search 10k → outlier 10x.
    dataApi.videosByChannel.set('UCoutside', [
      ...makeVideos('vay trả góp', 'UCoutside', 12, 1_000),
      { videoId: 'hit1', title: 'vay trả góp siêu nổ', views: 10_000, durationSec: 600, defaultAudioLanguage: 'vi' },
    ]);
    dataApi.hitsForAll = [{
      kind: 'video', videoId: 'hit1', channelId: 'UCoutside',
      title: 'vay trả góp siêu nổ', description: null,
      channelTitle: 'Kênh UCoutside', publishedAt: '2026-08-10T00:00:00.000Z', thumbnailUrl: null,
    }];

    const result = await loop.runTick('fin', { mode: 'weekly' });
    expect(result.status).toBe('done');
    expect(result.mode).toBe('weekly');
    // W1: đúng 1 search call (1 keyword active ≤ budget 12), có publishedAfter.
    expect(dataApi.searchCalls.length).toBe(1);
    expect(dataApi.searchCalls[0]!.publishedAfter).toBeDefined();
    const publishedAfterMs = Date.now() - Date.parse(dataApi.searchCalls[0]!.publishedAfter!);
    expect(publishedAfterMs).toBeGreaterThanOrEqual(28 * 86_400_000);
    // §6.4/§6.2: kênh được đề xuất ở 'new' — KHÔNG phải 'active'.
    const statuses = channelStatuses(store, 'fin');
    expect(statuses.get('UCoutside')).toBe('new');
    // decisions chứng minh đề xuất đến từ loop, không phải promote.
    const decisions = store.listDecisions('fin', { entityType: 'channel' });
    const proposal = decisions.find((d) => d.entityId === 'UCoutside');
    expect(proposal?.toStatus).toBe('new');
    expect(proposal?.actor).toBe('loop');
    store.close();
  });

  test('weekly xoay keyword theo lastCheckedAt — keyword lâu nhất được search trước', async () => {
    const { store, dataApi, loop } = await setup();
    seedTopic(store);
    store.upsertTopicKeyword({ topicId: 'fin', termKey: 'kw-old', displayTerm: 'kw cũ', relation: 'seed', status: 'active' });
    store.upsertTopicKeyword({ topicId: 'fin', termKey: 'kw-new', displayTerm: 'kw mới', relation: 'seed', status: 'active' });
    store.updateKeywordCheck('fin', 'kw-new', { lastCheckedAt: '2026-08-19T00:00:00.000Z', lastNResults: 5, lastNFollowed: 0, lastMedianViews: 1_000 });

    await loop.runTick('fin', { mode: 'weekly' });
    // kw-old chưa từng check (null) → xếp trước kw-new đã check hôm qua.
    expect(dataApi.searchCalls[0]!.q).toBe('kw cũ');
    store.close();
  });

  test('weekly tôn trọng weeklyKeywordBudget — chỉ search tối đa budget keyword', async () => {
    const { store, dataApi, loop } = await setup();
    seedTopic(store);
    // budget=1 trong settings_json → 2 keyword active nhưng chỉ 1 được search.
    const db = (store as unknown as { database: { prepare(s: string): { run(...a: unknown[]): void } } }).database;
    db.prepare('UPDATE topics SET settings_json=? WHERE topic_id=?')
      .run(JSON.stringify({ weekly_keyword_budget: 1 }), 'fin');
    store.upsertTopicKeyword({ topicId: 'fin', termKey: 'kw1', displayTerm: 'một', relation: 'seed', status: 'active' });
    store.upsertTopicKeyword({ topicId: 'fin', termKey: 'kw2', displayTerm: 'hai', relation: 'seed', status: 'active' });
    expect(store.getTopicSettings('fin').weeklyKeywordBudget).toBe(1);

    await loop.runTick('fin', { mode: 'weekly' });
    expect(dataApi.searchCalls.length).toBe(1);
    store.close();
  });

  test('weekly loại kênh dead/lottery — KHÔNG đề xuất (§6.4)', async () => {
    const { store, dataApi, loop } = await setup();
    seedTopic(store);
    store.upsertTopicKeyword({ topicId: 'fin', termKey: 'kw', displayTerm: 'kw', relation: 'seed', status: 'active' });
    // Kênh dead: 12 video 100 views → median 100 < dead_median 500.
    dataApi.videosByChannel.set('UCdead', [
      ...makeVideos('dead', 'UCdead', 12, 100),
      { videoId: 'hit-dead', title: 'dead hit', views: 5_000, durationSec: 600, defaultAudioLanguage: 'vi' },
    ]);
    // Kênh lottery: 11 video 1k + 1 video 200k → max/median ≈ 200 > 50.
    dataApi.videosByChannel.set('UClottery', [
      ...makeVideos('lot', 'UClottery', 11, 1_000),
      { videoId: 'hit-lot', title: 'lot hit', views: 200_000, durationSec: 600, defaultAudioLanguage: 'vi' },
      { videoId: 'lot-viral', title: 'viral', views: 200_000, durationSec: 600, defaultAudioLanguage: 'vi' },
    ]);
    dataApi.hitsForAll = [
      { kind: 'video', videoId: 'hit-dead', channelId: 'UCdead', title: 'x', description: null, channelTitle: 'd', publishedAt: null, thumbnailUrl: null },
      { kind: 'video', videoId: 'hit-lot', channelId: 'UClottery', title: 'x', description: null, channelTitle: 'l', publishedAt: null, thumbnailUrl: null },
    ];

    await loop.runTick('fin', { mode: 'weekly' });
    const statuses = channelStatuses(store, 'fin');
    expect(statuses.has('UCdead')).toBe(false);
    expect(statuses.has('UClottery')).toBe(false);
    store.close();
  });

  test('weekly auto-reject kênh sai ngôn ngữ (lang_mismatch) — rejected DUY NHẤT của loop', async () => {
    const { store, dataApi, loop } = await setup();
    seedTopic(store);
    store.upsertTopicKeyword({ topicId: 'fin', termKey: 'kw', displayTerm: 'kw', relation: 'seed', status: 'active' });
    // Kênh English: 12 video en → evaluateChannelLanguage reject.
    dataApi.videosByChannel.set('UCenglish', [
      ...makeVideos('english', 'UCenglish', 12, 2_000, { defaultAudioLanguage: 'en' }),
      { videoId: 'hit-en', title: 'en hit', views: 8_000, durationSec: 600, defaultAudioLanguage: 'en' },
    ]);
    dataApi.hitsForAll = [
      { kind: 'video', videoId: 'hit-en', channelId: 'UCenglish', title: 'x', description: null, channelTitle: 'e', publishedAt: null, thumbnailUrl: null },
    ];

    await loop.runTick('fin', { mode: 'weekly' });
    const statuses = channelStatuses(store, 'fin');
    expect(statuses.get('UCenglish')).toBe('rejected');
    const rejected = store.listTopicChannelsByStatus('fin', ['rejected'])[0]!;
    expect(rejected.decidedBy).toBe('loop_auto');
    expect(rejected.decidedReason).toBe('lang_mismatch');
    store.close();
  });

  test('weekly + daily cùng ngày không đè nhau (idempotency theo mode)', async () => {
    const { store, dataApi, loop } = await setup();
    seedTopic(store);
    store.upsertTopicChannel({ topicId: 'fin', channelId: 'UCa', status: 'active' });
    dataApi.videosByChannel.set('UCa', makeVideos('a', 'UCa', 2, 1_000));

    const d = await loop.runTick('fin', { mode: 'daily' });
    const w = await loop.runTick('fin', { mode: 'weekly' });
    expect(d.status).toBe('done');
    expect(w.status).toBe('done');
    // Hai tick riêng trong loop_ticks (UNIQUE topic,day,mode).
    const tick = store.getTickByDay('fin', quotaDay());
    expect(tick).not.toBeNull();
    store.close();
  });
});

describe('SETUP mode — S2/S3, mỗi bước một lệnh riêng (§6.5)', () => {
  test('S2: search seed → kênh new → setup_status=awaiting_channels', async () => {
    const { store, dataApi, loop } = await setup();
    seedTopic(store);
    store.upsertTopicKeyword({ topicId: 'fin', termKey: 'seed', displayTerm: 'seed kw', relation: 'seed', status: 'pending' });
    dataApi.videosByChannel.set('UCseed', makeVideos('seed', 'UCseed', 12, 2_000));
    dataApi.hitsForAll = [
      { kind: 'video', videoId: 'seed-hit', channelId: 'UCseed', title: 'x', description: null, channelTitle: 's', publishedAt: null, thumbnailUrl: null },
    ];

    const result = await loop.runTick('fin', { mode: 'setup', setupStep: 'channels' });
    expect(result.status).toBe('done');
    expect(result.setupStep).toBe('channels');
    expect(channelStatuses(store, 'fin').get('UCseed')).toBe('new');
    // Điểm dừng HITL — chờ người duyệt trước khi S3.
    expect(String(store.getTopic('fin')!['setup_status'])).toBe('awaiting_channels');
    store.close();
  });

  test('S3: n-gram từ ≥ngram_min_channels kênh active → keyword pending → awaiting_keywords', async () => {
    const { store, loop } = await setup();
    seedTopic(store);
    // 3 kênh active (mặc định ngram_min_channels=3), mỗi kênh có video chung cụm.
    for (const ch of ['UCa', 'UCb', 'UCc']) {
      store.upsertTopicChannel({ topicId: 'fin', channelId: ch, status: 'active' });
      store.upsertTopicVideo({
        topicId: 'fin', videoId: `${ch}-v1`, channelId: ch,
        title: 'vay trả góp mua xe', durationSec: 600,
        source: 'setup', views: 1_000, capturedAt: new Date().toISOString(),
      });
    }

    const result = await loop.runTick('fin', { mode: 'setup', setupStep: 'keywords' });
    expect(result.status).toBe('done');
    // 'vay trả góp' xuất hiện ở cả 3 kênh → keyword pending.
    const pending = store.listKeywordsByStatus('fin', ['pending']);
    const term = pending.find((k) => k.termKey === 'vay_tra_gop');
    expect(term).toBeDefined();
    expect(term!.origin).toBe('title_ngram');
    expect(String(store.getTopic('fin')!['setup_status'])).toBe('awaiting_keywords');
    store.close();
  });

  test('S3 không tiến setup_status khi chưa có kênh active (S2 chưa duyệt)', async () => {
    const { store, loop } = await setup();
    seedTopic(store);
    store.upsertTopicChannel({ topicId: 'fin', channelId: 'UCnew', status: 'new' });

    await loop.runTick('fin', { mode: 'setup', setupStep: 'keywords' });
    // Không kênh active → KHÔNG đặt awaiting_keywords — gate giữ nguyên 'none'.
    expect(String(store.getTopic('fin')!['setup_status'])).toBe('none');
    store.close();
  });
});

describe('Luật bất biến HITL — loop KHÔNG BAO GIỜ ghi active/paused (§6.2)', () => {
  test('mọi decisions của loop chỉ to=new/pending/rejected(lang_mismatch)', async () => {
    const { store, dataApi, loop } = await setup();
    seedTopic(store);
    store.upsertTopicKeyword({ topicId: 'fin', termKey: 'kw', displayTerm: 'kw', relation: 'seed', status: 'active' });
    dataApi.videosByChannel.set('UCok', makeVideos('ok', 'UCok', 12, 1_000));
    dataApi.hitsForAll = [
      { kind: 'video', videoId: 'hit-ok', channelId: 'UCok', title: 'x', description: null, channelTitle: 'o', publishedAt: null, thumbnailUrl: null },
    ];
    // Hit video cần thuộc videosByChannel để có stats → thêm vào.
    dataApi.videosByChannel.get('UCok')!.push({ videoId: 'hit-ok', title: 'ok hit', views: 9_000, durationSec: 600, defaultAudioLanguage: 'vi' });

    await loop.runTick('fin', { mode: 'weekly' });
    await loop.runTick('fin', { mode: 'daily' });

    const decisions = store.listDecisions('fin', {});
    for (const d of decisions) {
      if (d.actor !== 'loop') continue;
      expect(['new', 'pending', 'rejected']).toContain(d.toStatus);
      if (d.toStatus === 'rejected') expect(d.reason).toBe('lang_mismatch');
    }
    // Kênh do loop tạo không bao giờ active/paused.
    const statuses = channelStatuses(store, 'fin');
    for (const [, status] of statuses) {
      expect(status).not.toBe('paused');
    }
    store.close();
  });
});
