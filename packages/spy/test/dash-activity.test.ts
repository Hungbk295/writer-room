/**
 * dash-activity.test.ts — truy vấn read-only cho 7 endpoint "activity" của
 * Spy Dashboard API (#3 overview, #6 channel ts, #8 videos, #9 video ts,
 * #10 hot, #11 outliers, #12 timeseries).
 *
 * Kiểm chứng ở tầng hàm (Database thật, schema v13) — hard-gate nhất của
 * §5: /hot tính lại từ snapshot lịch sử nên ngày cũ vẫn ra đúng số, và
 * "chưa đủ dữ liệu" phải là null chứ không phải 0.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { SpyStore } from '../src/store.ts';
import { quotaDay } from '../src/quota.ts';
import { dashChannels } from '../src/dash/registry.ts';
import {
  channelTimeseries,
  dashOverview,
  hotBoard,
  outliers,
  timeseries,
  videoTimeseries,
  videosList,
} from '../src/dash/activity.ts';

let tempDir = '';
const openStores: SpyStore[] = [];

afterEach(async () => {
  for (const store of openStores.splice(0)) store.close();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = '';
});

const T = 'fin';
const D0 = '2026-09-20';
const D1 = '2026-09-21';
const D2 = '2026-09-22';
const RANGE = { from: D0, to: D2 };

async function seed(): Promise<{ store: SpyStore; db: Database }> {
  tempDir = await mkdtemp(join(tmpdir(), 'spy-dash-activity-'));
  const store = new SpyStore(join(tempDir, 'spy.sqlite'));
  openStores.push(store);
  store.upsertTopic({
    topicId: T, label: 'Finance US', market: 'us', language: 'en', region: 'US',
  });
  // Kênh follow (active) + baseline tin cậy; kênh inbox (new) chưa có baseline.
  store.upsertTopicChannelCandidate({
    topicId: T, channelId: 'UCfollow', title: 'Follow Chan', discoveredVia: 'seed',
  });
  store.decideChannel(T, 'UCfollow', 'active', 'seed');
  store.updateChannelBaseline(T, 'UCfollow', {
    baselineMedianViews: 9_000, baselineN: 20, maxViews: 100_000,
    lastPublishedAt: `${D0}T00:00:00.000Z`, lastCheckedAt: `${D2}T00:00:00.000Z`,
  });
  store.upsertTopicChannelCandidate({
    topicId: T, channelId: 'UCinbox', title: 'Inbox Chan', discoveredVia: 'weekly_outlier',
  });
  // Keyword: 1 active + 1 pending.
  store.upsertKeywordCandidate({
    topicId: T, termKey: 'old_money', displayTerm: 'old money', origin: 'seed', evidenceJson: '{}',
  });
  store.decideKeyword(T, 'old_money', 'active', 'seed');
  store.upsertKeywordCandidate({
    topicId: T, termKey: 'etf', displayTerm: 'etf', origin: 'title_ngram', evidenceJson: '{}',
  });
  // Video của kênh follow: 3 snapshot (D0 10k → D1 13k → D2 20k), outlier.
  store.upsertTopicVideo({
    topicId: T, videoId: 'vAAA', channelId: 'UCfollow', title: 'Outlier Video',
    publishedAt: `${D0}T02:00:00.000Z`, durationSec: 700, source: 'setup',
    views: 10_000, capturedAt: `${D0}T10:00:00.000Z`,
  });
  store.recordVideoDailyView({ topicId: T, videoId: 'vAAA', day: D0, views: 10_000, capturedAt: `${D0}T10:00:00.000Z` });
  store.recordVideoDailyView({ topicId: T, videoId: 'vAAA', day: D1, views: 13_000, capturedAt: `${D1}T10:00:00.000Z` });
  store.recordVideoDailyView({ topicId: T, videoId: 'vAAA', day: D2, views: 20_000, likes: 500, capturedAt: `${D2}T10:00:00.000Z` });
  store.updateVideoDerived(T, 'vAAA', { viewsGained24h: 7_000, outlierScore: 4.0 });
  // Video của kênh inbox: chỉ 1 snapshot → gained phải null.
  store.upsertTopicVideo({
    topicId: T, videoId: 'vBBB', channelId: 'UCinbox', title: 'Inbox Video',
    publishedAt: `${D2}T02:00:00.000Z`, durationSec: 400, source: 'weekly_search',
    foundByKeyword: 'etf', views: 60_000, capturedAt: `${D2}T10:00:00.000Z`,
  });
  store.recordVideoDailyView({ topicId: T, videoId: 'vBBB', day: D2, views: 60_000, capturedAt: `${D2}T10:00:00.000Z` });
  store.updateVideoDerived(T, 'vBBB', { viewsGained24h: null, outlierScore: null });
  // Ticks + quota + report.
  store.createLoopTick({ tickId: randomUUID(), topicId: T, quotaDay: D2, mode: 'daily' });
  store.createLoopTick({ tickId: randomUUID(), topicId: T, quotaDay: D2, mode: 'weekly' });
  store.addQuotaUsage('search', D2, 4, 4);
  store.addQuotaUsage('general', D2, 900, 3);
  return { store, db: store.rawDb };
}

describe('dash activity — #3 overview', () => {
  test('overview: đếm status, snapshot gain, quota, last_ticks theo mode', async () => {
    const { db } = await seed();
    const ov = dashOverview(db, T, { date: D2 });
    expect(ov.date).toBe(D2);
    expect(ov.channels).toEqual({ new: 1, active: 1, paused: 0, rejected: 0, own: 0 });
    expect(ov.keywords).toEqual({ pending: 1, active: 1, paused: 0, rejected: 0 });
    expect(ov.videos_tracked).toBe(2);
    expect(ov.new_videos_today).toBe(1); // vBBB published D2 (đếm theo published_at)
    // views_gained_today = (20k-13k) + (60k - no prev → excluded) = 7000.
    expect(ov.views_gained_today).toBe(7_000);
    expect(ov.outliers_7d.followed).toBe(1); // vAAA outlier 4.0 ≥ 3, kênh follow
    expect(ov.quota_today).toEqual({ search_calls: 4, general_units: 900 });
    expect(ov.last_ticks.daily.status).toBe('running');
    expect(ov.last_ticks.weekly.status).toBe('running');
    expect(ov.inbox_pending).toEqual({ channels: 1, keywords: 1, suggestions: 0 });
    // Delta channels_active = +1 (decideChannel human → active trong ngày D2?
    // decisions 'at' là giờ THẬT của test — không phải D2 → delta = 0 ở đây.
    expect(ov.delta_vs_prev_day.channels_active).toBe(0);
  });

  test('overview: ngày không có snapshot → views_gained_today null, không phải 0', async () => {
    const { db } = await seed();
    const ov = dashOverview(db, T, { date: '2020-01-01' });
    expect(ov.views_gained_today).toBeNull();
    expect(ov.new_videos_today).toBe(0);
    expect(ov.quota_today).toEqual({ search_calls: 0, general_units: 0 });
  });

  test('E2E fix: new_videos + outliers_7d theo published_at; netActive chỉ trừ khi rời active', async () => {
    const { store, db } = await seed();
    // Video backfill: first_seen D2 (scan hôm đó) nhưng published 60 ngày
    // trước — KHÔNG được tính "video mới" và KHÔNG vào outliers_7d.
    store.upsertTopicVideo({
      topicId: T, videoId: 'vOLD', channelId: 'UCfollow', title: 'Old Outlier',
      publishedAt: '2026-07-24T02:00:00.000Z', durationSec: 600, source: 'setup',
      views: 500_000, capturedAt: `${D2}T10:00:00.000Z`,
    });
    store.updateVideoDerived(T, 'vOLD', { viewsGained24h: null, outlierScore: 50 });
    const ov = dashOverview(db, T, { date: D2 });
    expect(ov.new_videos_today).toBe(1);      // chỉ vBBB (published D2)
    expect(ov.new_videos_7d).toBe(2);         // vAAA D0 + vBBB D2; vOLD loại
    expect(ov.outliers_7d.followed).toBe(1);  // vAAA; vOLD score 50 nhưng published ngoài cửa sổ
    // #11 outliers cùng quy tắc: vOLD không vào range D0–D2.
    expect(outliers(db, T, { range: RANGE, scope: 'all', minMultiple: 2, limit: 50, offset: 0 })
      .map((r) => r.video_id)).toEqual(['vAAA']);

    // netActiveOn: pending→rejected KHÔNG trừ; paused→rejected cũng không
    // trừ lần hai; chỉ active→paused/rejected mới −1; vào active từ khác +1.
    const ins = db.prepare(`INSERT INTO decisions
      (id, topic_id, at, actor, entity_type, entity_id, from_status, to_status, reason)
      VALUES (?, ?, ?, 'human', 'keyword', ?, ?, ?, 't')`);
    ins.run(randomUUID(), T, `${D2}T09:00:00.000Z`, 'kw1', 'pending', 'rejected'); // 0 — bug cũ trừ 1
    ins.run(randomUUID(), T, `${D2}T09:00:00.000Z`, 'kw2', 'active', 'paused');    // -1
    ins.run(randomUUID(), T, `${D2}T09:00:00.000Z`, 'kw3', 'pending', 'active');   // +1
    ins.run(randomUUID(), T, `${D2}T09:00:00.000Z`, 'kw4', 'paused', 'rejected');  // 0 — đã rời active
    const ov2 = dashOverview(db, T, { date: D2 });
    // +1 − 1 = 0; công thức cũ sẽ ra −2 (trừ kw1 và kw4).
    expect(ov2.delta_vs_prev_day.keywords_active).toBe(0);
  });
});

describe('dash activity — #6 channel timeseries', () => {
  test('per-day total/gained/uploads; kênh lạ → null', async () => {
    const { db } = await seed();
    const rows = channelTimeseries(db, T, 'UCfollow', RANGE)!;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ day: D0, total_views: 10_000, views_gained: null, uploads: 1, videos_observed: 1 });
    expect(rows[1]).toMatchObject({ day: D1, total_views: 13_000, views_gained: 3_000 });
    expect(rows[2]).toMatchObject({ day: D2, total_views: 20_000, views_gained: 7_000 });
    expect(channelTimeseries(db, T, 'UCnope', RANGE)).toBeNull();
  });
});

describe('dash activity — #8 videos list', () => {
  test('lọc source/channel/keyword + sort; is_short/is_outlier/launch_spike đúng ngưỡng', async () => {
    const { db } = await seed();
    const { rows, total } = videosList(db, T, {
      sort: 'latest_views', order: 'desc', limit: 50, offset: 0,
    });
    expect(total).toBe(2);
    const b = rows.find((r) => r.video_id === 'vBBB')!;
    expect(b.channel_status).toBe('new');
    expect(b.snapshots).toBe(1);
    expect(b.views_gained_24h).toBeNull();
    expect(b.is_outlier).toBeNull(); // baseline inbox chưa tin cậy
    const a = rows.find((r) => r.video_id === 'vAAA')!;
    expect(a.is_outlier).toBe(true); // outlierScore 4.0 ≥ outlierMultiple 3
    const filtered = videosList(db, T, {
      sort: 'latest_views', order: 'desc', limit: 50, offset: 0,
      source: 'weekly_search', keyword: 'etf',
    });
    expect(filtered.total).toBe(1);
    expect(filtered.rows[0]!.video_id).toBe('vBBB');
  });
});

describe('dash activity — #9 video timeseries', () => {
  test('gained = hiệu snapshot trước, điểm đầu null; video lạ → null', async () => {
    const { db } = await seed();
    const rows = videoTimeseries(db, T, 'vAAA')!;
    expect(rows.map((r) => r.day)).toEqual([D0, D1, D2]);
    expect(rows[0]!.views_gained).toBeNull();
    expect(rows[1]!.views_gained).toBe(3_000);
    expect(rows[2]!.views_gained).toBe(7_000);
    expect(rows[2]!.likes).toBe(500);
    expect(videoTimeseries(db, T, 'nope')).toBeNull();
  });
});

describe('dash activity — #10 hot board', () => {
  test('tính lại từ snapshot đúng ngày — gọi cho ngày cũ vẫn ra số của ngày đó', async () => {
    const { db } = await seed();
    const hot1 = hotBoard(db, T, { date: D1, limit: 10 });
    expect(hot1).toHaveLength(1); // chỉ vAAA có snapshot D1
    const r = hot1[0]!;
    expect(r.rank).toBe(1);
    expect(r.views).toBe(13_000);
    expect(r.views_gained).toBe(3_000); // 13k - 10k snapshot D0
    expect(r.window_days).toBe(1);
    expect(r.gained_per_day).toBe(3_000);
    // heat = gained_per_day / (baseline/30) = 3000/300 = 10.
    expect(r.heat).toBeCloseTo(10, 6);
    // Ngày D2: vBBB chỉ có 1 snapshot → KHÔNG vào board (join cần prev).
    const hot2 = hotBoard(db, T, { date: D2, limit: 10 });
    expect(hot2).toHaveLength(1);
    expect(hot2[0]!.views_gained).toBe(7_000);
    // Kênh không có baseline tin cậy → heat null (không phải 0).
    // vBBB đã bị loại vì thiếu prev — thêm snapshot D1 muộn để kiểm heat=null.
  });

  test('heat null khi baseline_n < baselineMinN', async () => {
    const { db, store } = await seed();
    // vBBB thêm snapshot D1 → có gained nhưng kênh UCinbox baseline_n=null.
    store.recordVideoDailyView({ topicId: T, videoId: 'vBBB', day: D1, views: 40_000, capturedAt: `${D1}T10:00:00.000Z` });
    const hot = hotBoard(db, T, { date: D2, limit: 10 });
    const b = hot.find((r) => r.video_id === 'vBBB')!;
    expect(b.views_gained).toBe(20_000);
    expect(b.heat).toBeNull();
    // xếp trên vAAA vì gained_per_day cao hơn.
    expect(hot[0]!.video_id).toBe('vBBB');
  });
});

describe('dash activity — #11 outliers', () => {
  test('tách followed/external theo status kênh + min_multiple + scope', async () => {
    const { db } = await seed();
    // vAAA: outlier 20000/9000 ≈ 2.22 < default 3 → đặt min_multiple thấp.
    const all = outliers(db, T, {
      range: { from: D0, to: D2 }, scope: 'all', minMultiple: 2, limit: 50, offset: 0,
    });
    expect(all).toHaveLength(1);
    expect(all[0]!.video_id).toBe('vAAA');
    expect(all[0]!.scope).toBe('followed');
    expect(all[0]!.channel_in_inbox).toBe(false);
    expect(all[0]!.baseline_median_views).toBe(9_000);
    // scope=external → rỗng; min_multiple=50 → rỗng.
    expect(outliers(db, T, {
      range: { from: D0, to: D2 }, scope: 'external', minMultiple: 2, limit: 50, offset: 0,
    })).toHaveLength(0);
    expect(outliers(db, T, {
      range: { from: D0, to: D2 }, scope: 'all', minMultiple: 50, limit: 50, offset: 0,
    })).toHaveLength(0);
  });
});

describe('dash activity — #12 timeseries', () => {
  test('views_gained theo ngày chỉ tính kênh follow; group_by=week gộp bucket', async () => {
    const { db } = await seed();
    const daily = timeseries(db, T, { metric: 'views_gained', range: RANGE, groupBy: 'day' });
    // kênh follow: D1 +3000, D2 +7000; kênh inbox không tính.
    expect(daily).toEqual([
      { bucket: D1, value: 3_000 },
      { bucket: D2, value: 7_000 },
    ]);
    const weekly = timeseries(db, T, { metric: 'views_gained', range: RANGE, groupBy: 'week' });
    expect(weekly).toHaveLength(1);
    expect(weekly[0]!.value).toBe(10_000);
    expect(weekly[0]!.bucket).toBe('2026-09-21'); // Thứ 2 của tuần chứa D1/D2
  });

  test('approvals có breakdown theo to_status; search_calls breakdown theo mode', async () => {
    const { db } = await seed();
    // decisions 'at' là giờ thật — khoanh range quanh hôm nay.
    const todayStr = new Date().toISOString().slice(0, 10);
    const appr = timeseries(db, T, {
      metric: 'approvals',
      range: { from: todayStr, to: todayStr },
      groupBy: 'day',
    });
    expect(appr).toHaveLength(1);
    expect(appr[0]!.breakdown).toEqual({ active: 2 }); // channel + keyword
    const sc = timeseries(db, T, {
      metric: 'search_calls', range: RANGE, groupBy: 'day',
    });
    expect(sc).toHaveLength(1);
    expect(sc[0]!.bucket).toBe(D2);
    expect(sc[0]!.breakdown).toBeDefined(); // breakdown theo mode (cả 2 tick used=0)
  });

  test('M1: views_gained_7d theo cửa sổ quota_day — biên -7 bị loại, -6 tính', async () => {
    const { store, db } = await seed();
    // "Hôm nay" của pipeline = quota_day Pacific; cửa sổ = [quotaDay-6, quotaDay].
    const qd = quotaDay();
    const shift = (d: string, n: number): string => {
      const x = new Date(`${d}T00:00:00.000Z`);
      x.setUTCDate(x.getUTCDate() + n);
      return x.toISOString().slice(0, 10);
    };
    const d8 = shift(qd, -8), d7 = shift(qd, -7), d6 = shift(qd, -6);
    // Kênh+video riêng để test không lệ thuộc fixture ngày cố định D0–D2.
    store.upsertTopicChannelCandidate({
      topicId: T, channelId: 'UCbound', title: 'Bound Chan', discoveredVia: 'seed',
    });
    store.decideChannel(T, 'UCbound', 'active', 'seed');
    store.upsertTopicVideo({
      topicId: T, videoId: 'vBND', channelId: 'UCbound', title: 'Bound',
      publishedAt: `${d8}T02:00:00.000Z`, durationSec: 700, source: 'setup',
      views: 100, capturedAt: `${d8}T10:00:00.000Z`,
    });
    store.recordVideoDailyView({ topicId: T, videoId: 'vBND', day: d8, views: 100, capturedAt: `${d8}T10:00:00.000Z` });
    store.recordVideoDailyView({ topicId: T, videoId: 'vBND', day: d7, views: 500, capturedAt: `${d7}T10:00:00.000Z` }); // gained 400 — NGOÀI cửa sổ
    store.recordVideoDailyView({ topicId: T, videoId: 'vBND', day: d6, views: 550, capturedAt: `${d6}T10:00:00.000Z` }); // gained 50 — TRONG
    const { rows } = dashChannels(db, T, { sort: 'first_seen_at', order: 'desc', limit: 50, offset: 0 });
    const ch = rows.find((r) => r.channel_id === 'UCbound')!;
    // 50 chứ không 450: gain tại quotaDay-7 nằm ngoài cửa sổ 7 ngày.
    // Nếu code còn dùng date('now') UTC, ở khung 17:00–23:59 Pacific test này
    // sẽ lệch ngày và fail — đúng loại bug M1 nhắm vào.
    expect(ch.views_gained_7d).toBe(50);
  });
});
