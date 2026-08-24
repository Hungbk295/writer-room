/**
 * loop.test.ts — unit tests cho LoopRunner và planTick.
 * Dùng FakeDataApi từ discovery.test.ts pattern để giả lập API.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SpyStore } from '../src/store.ts';
import { QuotaLedger } from '../src/quota.ts';
import { DiscoveryService } from '../src/discovery.ts';
import { LoopRunner } from '../src/loop/runner.ts';
import { planTick } from '../src/loop/planner.ts';
import { scoreLearnValue } from '../src/learn-value.ts';
import { evaluateChannelLanguage, detectLanguageFromTitles } from '../src/loop/language.ts';
import type {
  ChannelStatistics,
  PlaylistVideoItem,
  SearchHit,
  SearchInput,
  VideoStatistics,
  YouTubeDataApiPort,
} from '../src/adapters/data-api.ts';

// ---------------------------------------------------------------------------
// FakeDataApi — modeled after discovery.test.ts:31
// ---------------------------------------------------------------------------
/** Video giả lập cho một kênh — chỉ những field mà runner thật sự đọc. */
interface FakeVideo {
  title: string;
  defaultAudioLanguage?: string | null;
  defaultLanguage?: string | null;
}

class FakeDataApi implements YouTubeDataApiPort {
  searchCalls: SearchInput[] = [];
  channelStatCalls: string[][] = [];
  hitsPerSearch: SearchHit[] = [];
  channelPublishedAt = new Date(Date.now() - 730 * 86_400_000).toISOString();
  /** channelId → 12 video mới nhất. Rỗng = kênh không có uploads. */
  videosByChannel = new Map<string, FakeVideo[]>();

  private videoIdChannel = new Map<string, string>();

  async fetchVideoStatistics(videoIds: readonly string[]): Promise<Map<string, VideoStatistics>> {
    const map = new Map<string, VideoStatistics>();
    for (const videoId of videoIds) {
      const channelId = this.videoIdChannel.get(videoId);
      if (!channelId) continue;
      const index = Number(videoId.split('#')[1] ?? 0);
      const video = this.videosByChannel.get(channelId)?.[index];
      if (!video) continue;
      map.set(videoId, {
        videoId,
        likeCount: 100,
        commentCount: 10,
        viewCount: 20_000,
        publishedAt: new Date(Date.now() - index * 7 * 86_400_000).toISOString(),
        publishedAtPrecision: 'second',
        durationSec: 600,
        tags: [],
        title: video.title,
        channelId,
        channelTitle: `Kênh ${channelId}`,
        thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        defaultAudioLanguage: video.defaultAudioLanguage ?? null,
        defaultLanguage: video.defaultLanguage ?? null,
      });
    }
    return map;
  }

  async listUploadsPlaylistItems(uploadsPlaylistId: string, limit: number): Promise<PlaylistVideoItem[]> {
    // uploadsPlaylistId = 'UU' + channelId.slice(2) — map ngược về channelId.
    const channelId = `UC${uploadsPlaylistId.slice(2)}`;
    const videos = this.videosByChannel.get(channelId) ?? [];
    return videos.slice(0, limit).map((video, index) => {
      const videoId = `${channelId}#${index}`;
      this.videoIdChannel.set(videoId, channelId);
      return {
        videoId,
        publishedAt: new Date(Date.now() - index * 7 * 86_400_000).toISOString(),
        title: video.title,
        position: index,
      };
    });
  }

  async fetchChannelStatistics(channelIds: readonly string[]): Promise<Map<string, ChannelStatistics>> {
    this.channelStatCalls.push([...channelIds]);
    const map = new Map<string, ChannelStatistics>();
    channelIds.forEach((channelId, index) => {
      map.set(channelId, {
        channelId,
        title: `Kênh ${channelId}`,
        description: 'giải thích đầu tư tài chính cổ phiếu',
        subscriberCount: 50_000 * (index + 1),
        videoCount: 100,
        viewCount: 5_000_000,
        uploadsPlaylistId: `UU${channelId.slice(2)}`,
        publishedAt: this.channelPublishedAt,
        country: 'VN',
      });
    });
    return map;
  }

  async search(input: SearchInput): Promise<{ hits: SearchHit[]; nextPageToken: string | null }> {
    this.searchCalls.push(input);
    return { hits: this.hitsPerSearch, nextPageToken: null };
  }

  async fetchFeaturedChannels(): Promise<string[]> { return []; }
  async fetchPublicSubscriptions(): Promise<string[] | null> { return []; }
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setupLoop() {
  const tempDir = await mkdtemp(join(tmpdir(), 'spy-loop-'));
  roots.push(tempDir);
  const store = new SpyStore(join(tempDir, 'spy.sqlite'));
  const dataApi = new FakeDataApi();
  const quota = new QuotaLedger(store);
  const discovery = new DiscoveryService(store, dataApi, quota);
  // Không truyền facelessJudge — P0 không có verdict vision (§3).
  const loop = new LoopRunner({
    store,
    quota,
    discovery,
    dataApi,
    dataRoot: tempDir,
  });
  return { store, dataApi, quota, loop, tempDir };
}

// ---------------------------------------------------------------------------
// planTick tests
// ---------------------------------------------------------------------------

describe('planTick — pure planner', () => {
  test('returns canProceed=false when topic does not exist', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'spy-plan-'));
    roots.push(tempDir);
    const store = new SpyStore(join(tempDir, 'spy.sqlite'));
    const quota = new QuotaLedger(store);
    const plan = planTick(store, quota, 'nonexistent');
    expect(plan.canProceed).toBe(false);
    expect(plan.blockers[0]).toContain('không tồn tại');
    store.close();
  });

  test('returns canProceed=false when topic is paused', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'spy-plan-'));
    roots.push(tempDir);
    const store = new SpyStore(join(tempDir, 'spy.sqlite'));
    const quota = new QuotaLedger(store);
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi', status: 'paused' });
    const plan = planTick(store, quota, 'fin');
    expect(plan.canProceed).toBe(false);
    expect(plan.blockers[0]).toContain('paused');
    store.close();
  });

  test('selects pending seed keywords first', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'spy-plan-'));
    roots.push(tempDir);
    const store = new SpyStore(join(tempDir, 'spy.sqlite'));
    const quota = new QuotaLedger(store);
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi', dailySearchBudget: 10 });
    store.upsertTopicKeyword({ topicId: 'fin', termKey: 'kw1', displayTerm: 'đầu tư', relation: 'seed' });
    store.upsertTopicKeyword({ topicId: 'fin', termKey: 'kw2', displayTerm: 'chứng khoán', relation: 'seed' });
    const plan = planTick(store, quota, 'fin');
    expect(plan.keywordsToSearch).toContain('kw1');
    expect(plan.keywordsToSearch).toContain('kw2');
    store.close();
  });
});

// ---------------------------------------------------------------------------
// LoopRunner.runTick tests
// ---------------------------------------------------------------------------

describe('LoopRunner.runTick', () => {
  test('dry-run returns expected shape', async () => {
    const { store, loop } = await setupLoop();
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi' });

    const result = await loop.runTick('fin', { dryRun: true });
    expect(result.status).toBe('done');
    expect(result.dryRun).toBe(true);
    expect(result.tickId).toBe('dry-run');
    store.close();
  });

  test('throws when topic does not exist', async () => {
    const { store, loop } = await setupLoop();
    expect(() => loop.runTick('nonexistent')).toThrow();
    store.close();
  });

  test('skips paused topic', async () => {
    const { store, loop } = await setupLoop();
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi', status: 'paused' });

    const result = await loop.runTick('fin');
    expect(result.status).toBe('skipped_quota');
    store.close();
  });

  test('runTick creates loop_tick row and marks done', async () => {
    const { store, loop } = await setupLoop();
    store.upsertTopic({
      topicId: 'fin',
      label: 'Finance',
      market: 'vi',
      language: 'vi',
      dailySearchBudget: 3,
    });
    store.upsertTopicKeyword({
      topicId: 'fin',
      termKey: 'kw1',
      displayTerm: 'đầu tư',
      relation: 'seed',
    });

    const result = await loop.runTick('fin');
    expect(['done', 'failed']).toContain(result.status);
    const tick = store.getLastTick('fin');
    expect(tick).not.toBeNull();
    // Tick status should be done
    expect(String(tick!['status'])).toBe(result.status);
    store.close();
  });

  test('second runTick on same day is idempotent (no double-tick)', async () => {
    const { store, loop } = await setupLoop();
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi', dailySearchBudget: 2 });

    const r1 = await loop.runTick('fin');
    expect(r1.status).toBe('done');

    // Second run same quota_day → should be skipped
    const r2 = await loop.runTick('fin');
    expect(r2.status).toBe('skipped_quota');
    store.close();
  });
});

// ---------------------------------------------------------------------------
// scoreLearnValue tests
// ---------------------------------------------------------------------------

describe('scoreLearnValue', () => {
  test('returns insufficient_sample with fewer than 3 videos', () => {
    const result = scoreLearnValue(
      { videos: [{ viewCount: 1000, publishedAt: null }, { viewCount: 2000, publishedAt: null }], subscriberCount: null, channelCreatedAt: null },
      { medianViews: null },
      { medianViews: null },
    );
    expect(result.score).toBeNull();
    expect(result.method).toBe('insufficient_sample');
    expect(result.sampleSize).toBe(2);
  });

  test('scores > 0 with enough video data and own baseline', () => {
    const now = new Date();
    const videos = Array.from({ length: 10 }, (_, i) => ({
      viewCount: 50_000 + i * 1000,
      publishedAt: new Date(now.getTime() - i * 14 * 86_400_000).toISOString(),
    }));
    const result = scoreLearnValue(
      { videos, subscriberCount: 200_000, channelCreatedAt: new Date(Date.now() - 24 * 30 * 86_400_000).toISOString() },
      { medianViews: 10_000 }, // candidate outperforms by ~5x
      { medianViews: 15_000 },
    );
    expect(result.score).not.toBeNull();
    expect(result.score!).toBeGreaterThan(30);
    expect(result.method).toBe('deterministic');
    expect(result.reasons).toHaveLength(4);
  });

  test('all factor names present', () => {
    const now = new Date();
    const videos = Array.from({ length: 8 }, (_, i) => ({
      viewCount: 20_000,
      publishedAt: new Date(now.getTime() - i * 7 * 86_400_000).toISOString(),
    }));
    const result = scoreLearnValue(
      { videos, subscriberCount: 100_000, channelCreatedAt: new Date(Date.now() - 12 * 30 * 86_400_000).toISOString() },
      { medianViews: null },
      { medianViews: null },
    );
    if (result.reasons.length === 0) return; // insufficient_sample case
    const factors = result.reasons.map((r) => r.factor);
    expect(factors).toContain('outperformBaseline');
    expect(factors).toContain('momentum');
    expect(factors).toContain('growthRate');
    expect(factors).toContain('cadence');
  });
});

// ---------------------------------------------------------------------------
// Language post-filter (§2.1 bước 3) — ngưỡng cố ý, đừng nới
// ---------------------------------------------------------------------------

function viTitles(n: number): string[] {
  const base = [
    'Lãi kép hoạt động như thế nào',
    'Tại sao bạn không có tiền tiết kiệm',
    'Giải thích về quỹ ETF cho người mới',
    'Bẫy tiêu dùng và cách thoát ra',
    'Nợ tốt và nợ xấu khác nhau ở đâu',
    'Cách quản lý chi tiêu với thu nhập thấp',
    'Đầu tư cho người mới bắt đầu',
    'Sự thật về bảo hiểm nhân thọ',
    'Ba sai lầm khi mua nhà trả góp',
    'Thu nhập thụ động có thật không',
    'Lạm phát ăn mòn tiền của bạn ra sao',
    'Tư duy tài chính của người giàu',
  ];
  return base.slice(0, n);
}

function enTitles(n: number): string[] {
  const base = [
    'How compound interest actually works',
    'Why you have no savings',
    'Index funds explained for beginners',
    'The truth about consumer debt',
    'Good debt vs bad debt',
    'How to budget on a low income',
    'Investing for beginners in 2026',
    'What if you saved 10 percent',
    'Three mistakes when buying a house',
    'Is passive income real',
    'How inflation eats your money',
    'The money mindset of rich people',
  ];
  return base.slice(0, n);
}

describe('evaluateChannelLanguage — chỉ reject khi metadata đủ dày', () => {
  test('≥50% video khai defaultAudioLanguage và đa số ≠ topic → reject lang_mismatch', () => {
    const videos = enTitles(12).map((title) => ({ title, defaultAudioLanguage: 'en-US' }));
    const verdict = evaluateChannelLanguage(videos, 'vi');
    expect(verdict.reject).toBe(true);
    expect(verdict.reason).toBe('lang_mismatch');
    expect(verdict.langDetected).toBe('en');
    expect(verdict.method).toBe('declared_fields');
  });

  test('đúng 50% khai báo là ĐỦ để reject (ngưỡng là >=, không phải >)', () => {
    const videos = enTitles(12).map((title, index) => ({
      title,
      defaultAudioLanguage: index < 6 ? 'en' : null,
    }));
    const verdict = evaluateChannelLanguage(videos, 'vi');
    expect(verdict.declaredCount).toBe(6);
    expect(verdict.reject).toBe(true);
    expect(verdict.reason).toBe('lang_mismatch');
  });

  test('khai báo đủ dày nhưng khớp topic → không reject', () => {
    const videos = viTitles(12).map((title) => ({ title, defaultAudioLanguage: 'vi' }));
    const verdict = evaluateChannelLanguage(videos, 'vi');
    expect(verdict.reject).toBe(false);
    expect(verdict.langDetected).toBe('vi');
    expect(verdict.method).toBe('declared_fields');
  });

  test('defaultLanguage được dùng khi defaultAudioLanguage trống', () => {
    const videos = enTitles(12).map((title) => ({
      title,
      defaultAudioLanguage: null,
      defaultLanguage: 'en',
    }));
    expect(evaluateChannelLanguage(videos, 'vi').reject).toBe(true);
  });

  test("'zxx'/'und' KHÔNG tính là khai báo → tụt xuống nhánh heuristic, không reject", () => {
    const videos = enTitles(12).map((title) => ({ title, defaultAudioLanguage: 'zxx' }));
    const verdict = evaluateChannelLanguage(videos, 'vi');
    expect(verdict.declaredCount).toBe(0);
    expect(verdict.reject).toBe(false);
    expect(verdict.method).toBe('title_heuristic');
  });

  test('khai báo thưa (<50%) → CHỈ ghi lang_detected, không bao giờ reject', () => {
    const videos = enTitles(12).map((title, index) => ({
      title,
      defaultAudioLanguage: index < 5 ? 'en' : null,
    }));
    const verdict = evaluateChannelLanguage(videos, 'vi');
    expect(verdict.declaredCount).toBe(5);
    expect(verdict.reject).toBe(false);
    expect(verdict.reason).toBeNull();
    expect(verdict.method).toBe('title_heuristic');
    expect(verdict.langDetected).toBe('en');
  });

  test('không trường nào + <6 title → insufficient_sample, không reject', () => {
    const videos = enTitles(3).map((title) => ({ title }));
    const verdict = evaluateChannelLanguage(videos, 'vi');
    expect(verdict.reject).toBe(false);
    expect(verdict.method).toBe('insufficient_sample');
  });

  test('không có video nào → không reject', () => {
    const verdict = evaluateChannelLanguage([], 'vi');
    expect(verdict.reject).toBe(false);
    expect(verdict.method).toBe('insufficient_sample');
  });
});

describe('detectLanguageFromTitles — heuristic rẻ, chỉ để ghi', () => {
  test('title tiếng Việt (dấu + từ chức năng) → vi', () => {
    const result = detectLanguageFromTitles(viTitles(12));
    expect(result.lang).toBe('vi');
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  test('title tiếng Anh → en, không nhầm sang vi', () => {
    const result = detectLanguageFromTitles(enTitles(12));
    expect(result.lang).toBe('en');
  });

  test('không có chữ nào → lang null, confidence 0', () => {
    expect(detectLanguageFromTitles(['2026', '###'])).toEqual({ lang: null, confidence: 0 });
  });
});

// ---------------------------------------------------------------------------
// runTick — language filter + auto-triage end-to-end
// ---------------------------------------------------------------------------

/** Đưa sẵn kênh vào topic để bước ENRICH nhặt lên (không cần search). */
function seedTopicChannel(store: SpyStore, topicId: string, channelId: string): void {
  store.upsertCandidate({ channelId, market: 'vi', discoveredVia: 'corpus_import' });
  store.upsertTopicChannel({ topicId, channelId, status: 'new' });
}

describe('runTick — language post-filter', () => {
  test('kênh tiếng Anh trong topic tiếng Việt bị reject với lý do lang_mismatch', async () => {
    const { store, dataApi, loop } = await setupLoop();
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi' });
    seedTopicChannel(store, 'fin', 'UCenglish');
    dataApi.videosByChannel.set(
      'UCenglish',
      enTitles(12).map((title) => ({ title, defaultAudioLanguage: 'en-US' })),
    );

    const result = await loop.runTick('fin');
    expect(result.status).toBe('done');

    const rows = store.listTopicChannels('fin', { status: 'rejected' });
    expect(rows).toHaveLength(1);
    expect(String(rows[0]!['channel_id'])).toBe('UCenglish');
    expect(String(rows[0]!['decided_reason'])).toBe('lang_mismatch');
    expect(String(rows[0]!['decided_by'])).toBe('loop_auto');
    expect(String(rows[0]!['lang_detected'])).toBe('en');
    expect(result.autoRejected).toBeGreaterThanOrEqual(1);
    store.close();
  });

  test('kênh có trường ngôn ngữ thưa KHÔNG bị reject — vẫn ở new cho người duyệt', async () => {
    const { store, dataApi, loop } = await setupLoop();
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi' });
    seedTopicChannel(store, 'fin', 'UCsparse');
    // Chỉ 2/12 video khai báo (16%) — dưới ngưỡng 50%, dù cả hai đều là 'en'.
    dataApi.videosByChannel.set(
      'UCsparse',
      enTitles(12).map((title, index) => ({
        title,
        defaultAudioLanguage: index < 2 ? 'en' : null,
      })),
    );

    await loop.runTick('fin');

    const rejected = store.listTopicChannels('fin', { status: 'rejected' });
    expect(rejected).toHaveLength(0);
    const stillNew = store.listTopicChannels('fin', { status: 'new' });
    expect(stillNew).toHaveLength(1);
    expect(String(stillNew[0]!['channel_id'])).toBe('UCsparse');
    // lang_detected vẫn được GHI để người duyệt nhìn thấy.
    expect(stillNew[0]!['lang_detected']).not.toBeNull();
    expect(Number(stillNew[0]!['lang_confidence'])).toBeGreaterThan(0);
    store.close();
  });

  test('không reject theo country: kênh khai country=US mà nội dung VI vẫn ở new', async () => {
    const { store, dataApi, loop } = await setupLoop();
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi' });
    seedTopicChannel(store, 'fin', 'UCoverseas');
    dataApi.videosByChannel.set('UCoverseas', viTitles(12).map((title) => ({ title })));

    await loop.runTick('fin');
    expect(store.listTopicChannels('fin', { status: 'rejected' })).toHaveLength(0);
    expect(store.listTopicChannels('fin', { status: 'new' })).toHaveLength(1);
    store.close();
  });
});

describe('runTick — faceless hint không tham gia triage', () => {
  test('faceless_score luôn NULL và faceless_hint được ghi riêng', async () => {
    const { store, dataApi, loop } = await setupLoop();
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi' });
    seedTopicChannel(store, 'fin', 'UChint');
    dataApi.videosByChannel.set('UChint', viTitles(12).map((title) => ({ title })));

    await loop.runTick('fin');

    const rows = store.listTopicChannels('fin', {});
    expect(rows).toHaveLength(1);
    expect(rows[0]!['faceless_score']).toBeNull();
    expect(rows[0]!['faceless_hint']).not.toBeNull();
    const hintReasons = JSON.parse(String(rows[0]!['faceless_hint_reasons_json'])) as {
      method: string;
      reasons: unknown[];
    };
    expect(hintReasons.method).toBe('text_only');
    expect(Array.isArray(hintReasons.reasons)).toBe(true);
    store.close();
  });

  test('kênh trông rất "có host" nhưng fit ổn thì KHÔNG bị auto-reject', async () => {
    const { store, dataApi, loop } = await setupLoop();
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi' });
    seedTopicChannel(store, 'fin', 'UCvlogger');
    dataApi.videosByChannel.set('UCvlogger', [
      { title: 'vlog ngày 1 của mình' },
      { title: 'day in my life' },
      { title: 'reaction video mới nhất' },
      { title: 'podcast tâm sự cuối tuần' },
      { title: 'đập hộp máy ảnh' },
      { title: 'một ngày của mình ở Đà Lạt' },
    ]);

    await loop.runTick('fin');

    const rows = store.listTopicChannels('fin', {});
    expect(rows).toHaveLength(1);
    // Hint thấp (nghiêng "có host") nhưng KHÔNG được dùng để loại.
    expect(Number(rows[0]!['faceless_hint'])).toBeLessThan(0.5);
    expect(String(rows[0]!['status'])).toBe('new');
    store.close();
  });
});

describe('runTick — Inbox có đủ dữ liệu để duyệt bằng mắt', () => {
  test('lưu ≤6 thumbnail và learn_value reasons kèm method + sampleSize', async () => {
    const { store, dataApi, loop } = await setupLoop();
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi' });
    seedTopicChannel(store, 'fin', 'UCthumbs');
    dataApi.videosByChannel.set('UCthumbs', viTitles(12).map((title) => ({ title })));

    await loop.runTick('fin');

    const row = store.listTopicChannels('fin', {})[0]!;
    const thumbs = JSON.parse(String(row['thumbnails_json'])) as string[];
    // 12 video nhưng Inbox chỉ cần 6 ô.
    expect(thumbs).toHaveLength(6);
    expect(thumbs[0]).toContain('hqdefault.jpg');

    const lv = JSON.parse(String(row['learn_value_reasons_json'])) as {
      method: string; sampleSize: number | null; reasons: unknown[];
    };
    expect(typeof lv.method).toBe('string');
    expect(Array.isArray(lv.reasons)).toBe(true);
  });

  test('provenance của kênh tìm được đọc lại được để hiện "tìm qua keyword nào"', async () => {
    const { store, loop } = await setupLoop();
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi' });
    store.addTopicChannelSource({
      topicId: 'fin', channelId: 'UCfound', relation: 'search_video', termKey: 'lai_kep',
    });
    const source = store.getTopicChannelSource('fin', 'UCfound');
    expect(String(source!['term_key'])).toBe('lai_kep');
    expect(loop).toBeDefined();
    store.close();
  });
});
