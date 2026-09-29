/**
 * board-queries.test.ts — 6 truy vấn Board trên DB thật (plan
 * spy-analyst-workflow §F1): scorecard theo ngách, video outlier/đang lên có
 * tier, kênh theo ngách, keyword khoá 3 ngày, sổ lượt chạy gộp tick + run.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SpyStore } from '../src/store.ts';
import {
  boardChannels,
  boardKeywords,
  boardMetrics,
  boardRunDetail,
  boardRuns,
  boardScorecard,
  boardVideos,
} from '../src/board/queries.ts';

const NOW = Date.parse('2026-09-29T12:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const T = 'fin';

let tempDir = '';
afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = '';
});

function addUploads(store: SpyStore, channelId: string, views: number[], opts: { source?: string; startDaysAgo?: number } = {}) {
  views.forEach((v, i) => {
    store.upsertTopicVideo({
      topicId: T, videoId: `${channelId}-${i}`, channelId, title: `${channelId} video ${i}`,
      publishedAt: daysAgo((opts.startDaysAgo ?? 10) + i), durationSec: 600,
      source: opts.source ?? 'daily_scan', views: v, capturedAt: daysAgo(0),
    });
  });
}

/**
 * Ngách "vay": kênh theo dõi A (8K subs, 12 video 1.000 + hit 5.000 cách 9 ngày),
 * kênh đã đo B (3K subs, 4 video: 12.000/400/600/900 → ⚠️ 18.46x... xem test),
 * kênh đã đo C (2K subs, 2 video 45.000/300 → 🆕), kênh to D (500K subs).
 * Ngách "the": kênh E (5K subs, 12 video 200 → kênh chết).
 */
async function seed() {
  tempDir = await mkdtemp(join(tmpdir(), 'spy-board-q-'));
  const store = new SpyStore(join(tempDir, 'spy.sqlite'));
  store.upsertTopic({ topicId: T, label: 'Fin', market: 'en', language: 'en', region: 'US' });
  store.upsertTopicKeyword({ topicId: T, termKey: 'vay_nhanh', displayTerm: 'vay nhanh', relation: 'seed', status: 'active', groupKey: 'vay' });
  store.upsertTopicKeyword({ topicId: T, termKey: 'the_tin_dung', displayTerm: 'thẻ tín dụng', relation: 'seed', status: 'active', groupKey: 'the' });

  store.upsertTopicChannel({ topicId: T, channelId: 'A', status: 'active', title: 'Kênh A', subscriberCount: 8_000 });
  store.setTopicChannelMeta(T, 'A', { groupKey: 'vay', channelPublishedAt: daysAgo(90) });
  addUploads(store, 'A', Array.from({ length: 12 }, () => 1_000), { startDaysAgo: 11 });
  store.upsertTopicVideo({
    topicId: T, videoId: 'A-hit', channelId: 'A', title: 'A hit', publishedAt: daysAgo(9),
    durationSec: 600, source: 'daily_scan', views: 5_000, capturedAt: daysAgo(0), foundByKeyword: 'vay_nhanh',
  });

  const measured = (channelId: string, subs: number, group: string, verdict: 'no_outlier' | 'unreliable' | 'dead' | 'proposed') =>
    store.upsertMeasuredChannel({
      topicId: T, channelId, title: `Kênh ${channelId}`, subscriberCount: subs, baselineMedianViews: null,
      baselineN: null, maxViews: null, verdict, hitOutlierScore: null, discoveredVia: 'keyword_run',
      discoveredFrom: 'vay_nhanh', measuredAt: daysAgo(1), groupKey: group, channelPublishedAt: daysAgo(40),
    });
  measured('B', 3_000, 'vay', 'unreliable');
  addUploads(store, 'B', [12_000, 400, 600, 700, 900], { source: 'outside_scan' });
  measured('C', 2_000, 'vay', 'unreliable');
  addUploads(store, 'C', [45_000, 300], { source: 'outside_scan' });
  measured('D', 500_000, 'vay', 'no_outlier');
  addUploads(store, 'D', Array.from({ length: 12 }, () => 200_000), { source: 'outside_scan' });
  // Video đang lên (2 ngày tuổi) của A.
  store.upsertTopicVideo({
    topicId: T, videoId: 'A-young', channelId: 'A', title: 'A young', publishedAt: daysAgo(2),
    durationSec: 600, source: 'daily_scan', views: 9_000, capturedAt: daysAgo(0),
  });
  store.updateVideoDerived(T, 'A-young', { viewsGained24h: 4_000, outlierScore: null });

  measured('E', 5_000, 'the', 'dead');
  addUploads(store, 'E', [...Array.from({ length: 12 }, () => 200), 700], { source: 'outside_scan' });
  return store;
}

describe('boardScorecard', () => {
  test('sàn view theo kênh, độ lặp theo tier, luật dừng', async () => {
    const store = await seed();
    const res = boardScorecard(store.rawDb, T, { nowMs: NOW });
    const vay = res.data.find((r) => r.niche === 'vay')!;
    // Kênh nhỏ A,B,C (D to). Median từng kênh (video ≥7 ngày hoặc ≥500 views):
    // A: 12×1000 + 5000 + young 9000 → 1000; B: median(12000,400,600,700,900)=700;
    // C: median(45000,300)=22650 → median kênh = 1000.
    expect(vay.floorSmall).toBe(1_000);
    expect(vay.nSmallChannels).toBe(3);
    // Outlier: A-hit 5x ✅, B-0 12000/650 ⚠️, C-0 45000/sàn 1000 🆕.
    expect(vay.repeat).toEqual({ total: 3, reliable: 1, thin: 1, niche: 1 });
    expect(vay.stop.ready).toBe(false);
    expect(vay.stop.smallMeasured).toBe(3);
    expect(vay.stop.need).toBe(20);
    expect(vay.history.length).toBe(28);

    const the = res.data.find((r) => r.niche === 'the')!;
    // Kênh E chết → không có outlier dù video 700 = 3.5x.
    expect(the.repeat.total).toBe(0);
    expect(res.sample.channels).toBe(4);
    expect(res.dataAsOf).not.toBeNull();
    store.close();
  });
});

describe('boardVideos', () => {
  test('outliers có tier + mức thường; đang lên xếp theo views 24h', async () => {
    const store = await seed();
    const out = boardVideos(store.rawDb, T, { niche: 'vay', view: 'outliers', nowMs: NOW });
    const byId = new Map(out.data.map((r) => [r.videoId, r]));
    expect(byId.get('A-hit')!.tier).toBe('reliable');
    expect(byId.get('A-hit')!.outlierX).toBe(5);
    expect(byId.get('A-hit')!.foundByKeyword).toBe('vay_nhanh');
    expect(byId.get('B-0')!.tier).toBe('thin');
    expect(byId.get('B-0')!.outlierX).toBe(18.46);
    expect(byId.get('B-0')!.baselineN).toBe(4);
    expect(byId.get('C-0')!.tier).toBe('niche');
    expect(byId.get('C-0')!.outlierX).toBe(45);
    expect(byId.has('A-young')).toBe(false);
    // Sort mặc định outlier_x giảm dần.
    expect(out.data[0]!.videoId).toBe('C-0');

    const rising = boardVideos(store.rawDb, T, { niche: 'vay', view: 'rising', nowMs: NOW });
    expect(rising.data.map((r) => r.videoId)).toEqual(['A-young']);
    expect(rising.data[0]!.velocity24h).toBe(4_000);

    const small = boardVideos(store.rawDb, T, { niche: 'vay', view: 'all', smallOnly: true, nowMs: NOW, limit: 2 });
    expect(small.data.length).toBe(2);
    expect(small.truncated).toBe(true);
    expect(small.data.every((r) => r.channelId !== 'D')).toBe(true);

    const young = boardVideos(store.rawDb, T, { niche: 'vay', view: 'outliers', channelAgeMaxDays: 60, nowMs: NOW });
    expect(young.data.map((r) => r.channelId).sort()).toEqual(['B', 'C']);
    store.close();
  });
});

describe('kênh chưa quét uploads', () => {
  test('video hot chỉ có từ kết quả search của kênh chưa quét KHÔNG bị chấm 🆕/outlier so với sàn ngách', async () => {
    const store = await seed();
    // Kênh UCghost không có trong topic_channels/measured_channels: chỉ biết 1 video từ search.
    store.upsertTopicVideo({
      topicId: T, videoId: 'ghost-hit', channelId: 'UCghost', title: 'viral of a big channel',
      publishedAt: daysAgo(12), durationSec: 600, source: 'keyword_run', foundByKeyword: 'vay_nhanh',
      views: 2_000_000, capturedAt: daysAgo(0),
    });
    const all = boardVideos(store.rawDb, T, { niche: 'vay', view: 'all', nowMs: NOW, limit: 100 });
    const ghost = all.data.find((r) => r.videoId === 'ghost-hit')!;
    expect(ghost.tier).toBeNull();
    expect(ghost.outlierX).toBeNull();
    expect(ghost.isOutlier).toBe(false);
    expect(boardVideos(store.rawDb, T, { niche: 'vay', view: 'outliers', nowMs: NOW }).data.map((r) => r.videoId))
      .not.toContain('ghost-hit');
    // Kênh đã đo (C: 2 video) vẫn được chấm 🆕 như cũ.
    expect(all.data.find((r) => r.videoId === 'C-0')!.tier).toBe('niche');
    store.close();
  });
});

describe('boardChannels', () => {
  test('kênh theo ngách: trạng thái, mức thường, outlier 28 ngày', async () => {
    const store = await seed();
    const res = boardChannels(store.rawDb, T, { niche: 'vay', smallOnly: true, nowMs: NOW });
    const byId = new Map(res.data.map((r) => [r.channelId, r]));
    expect([...byId.keys()].sort()).toEqual(['A', 'B', 'C']);
    expect(byId.get('A')!.state).toBe('following');
    expect(byId.get('A')!.tier).toBe('reliable');
    expect(byId.get('B')!.state).toBe('measured');
    expect(byId.get('B')!.tier).toBe('thin');
    expect(byId.get('C')!.tier).toBeNull();
    expect(byId.get('C')!.outliers28d).toBe(1);
    const dead = boardChannels(store.rawDb, T, { niche: 'the', nowMs: NOW }).data[0]!;
    expect(dead.dead).toBe(true);
    store.close();
  });
});

describe('boardKeywords', () => {
  test('khoá 3 ngày, tỉ lệ mới, outlier tìm ra', async () => {
    const store = await seed();
    store.updateKeywordCheck(T, 'vay_nhanh', {
      lastCheckedAt: daysAgo(1), lastNResults: 40, lastNFollowed: 2, lastMedianViews: 900, nNew: 10,
    });
    const res = boardKeywords(store.rawDb, T, { niche: 'vay', nowMs: NOW });
    expect(res.data.length).toBe(1);
    const kw = res.data[0]!;
    expect(kw.lockedUntil).toBe(new Date(Date.parse(daysAgo(1)) + 3 * 86_400_000).toISOString());
    expect(kw.newRate).toBe(0.25);
    expect(kw.outliersFound).toBe(1);
    store.close();
  });
});

describe('boardRuns / boardRunDetail', () => {
  test('gộp lượt chạy thủ công + tick loop, mới nhất trước; chi tiết có lý do bỏ qua', async () => {
    const store = await seed();
    store.createKeywordRun({
      runId: 'r1', topicId: T, paramsJson: '{}', nKeywords: 2, startedAt: daysAgo(1),
      note: 'Tìm kênh nhỏ', groupKey: 'vay',
    });
    store.insertKeywordRunItem({ runId: 'r1', termKey: 'vay_nhanh', status: 'done', nResults: 40, nNew: 10 });
    store.insertKeywordRunItem({ runId: 'r1', termKey: 'x', status: 'skipped_dedup', skipReason: 'searched_at:y' });
    store.updateKeywordRun('r1', { status: 'done', finishedAt: daysAgo(1), nNew: 10, nSkipped: 1 });
    store.rawDb.prepare(
      `INSERT INTO loop_ticks (tick_id, topic_id, quota_day, started_at, finished_at, status, mode)
       VALUES ('t1', ?, '2026-09-29', ?, ?, 'done', 'daily')`,
    ).run(T, daysAgo(0.1), daysAgo(0.05));

    const runs = boardRuns(store.rawDb, T, {});
    expect(runs.data.map((c) => [c.runId, c.type])).toEqual([['t1', 'track'], ['r1', 'discover']]);
    expect(runs.data[1]!.note).toBe('Tìm kênh nhỏ');
    expect(runs.data[1]!.nSkipped).toBe(1);
    expect(runs.freshness.lastTrackAt).toBe(daysAgo(0.05));
    expect(runs.freshness.lastDiscoverAt).toBe(daysAgo(1));
    expect(boardRuns(store.rawDb, T, { niche: 'vay' }).data.map((c) => c.runId)).toEqual(['r1']);

    const detail = boardRunDetail(store.rawDb, 'r1')!;
    expect(detail.data.items.find((i) => i.target === 'x')!.skipReason).toBe('searched_at:y');
    expect(boardRunDetail(store.rawDb, 'nope')).toBeNull();
    expect(boardMetrics(store.rawDb, T).map((m) => m.name)).toContain('floor_small');
    store.close();
  });
});
