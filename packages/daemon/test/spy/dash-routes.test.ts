/**
 * Spy Dashboard API (plan spy-dashboard-api.html) — 16 endpoint GET read-only
 * dưới /api/spy/dash/*.
 *
 * Test đi qua ROUTE THẬT (`createHandler` + HttpApp) trên DB test trong tmpdir:
 * mỗi endpoint phải trả 200 với envelope {data, meta}; tham số sai → 400;
 * topic/entity không tồn tại → 404; method khác GET → 405; format=csv → CSV.
 * Phần activity (#3,#6,#8–#12) đang là stub của Devin B — test kiểm 200 +
 * envelope/chữ ký, số liệu thật do B kiểm khi ghép.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SpyService, quotaDay } from '@writer-room/spy';
import { createHandler, type HttpApp } from '../../src/http.ts';

let root = '';
let spy: SpyService | undefined;

afterEach(async () => {
  spy?.store.close();
  spy = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

const TOPIC = 'finance-us';
const CH_ACTIVE = 'UCactive00000000000001';
const CH_NEW = 'UCnewchan00000000000002';
const VID = 'dQw4w9WgXcQ';

async function boot(): Promise<{ service: SpyService; handler: (req: Request) => Promise<Response> }> {
  root = await mkdtemp(join(tmpdir(), 'writer-room-dash-'));
  const service = new SpyService({ dataRoot: join(root, 'spy') });
  await service.init();
  spy = service;
  const app: HttpApp = {
    spy: service,
    spyMcp: null,
    generalPackMcp: null,
    harness: {} as unknown as HttpApp['harness'],
    startedAt: Date.now(),
    webRoot: '',
    loopScheduler: null,
    loop: null,
  };
  return { service, handler: createHandler(app) };
}

const get = (handler: (r: Request) => Promise<Response>, path: string) =>
  handler(new Request(`http://127.0.0.1:4187/api/spy/dash${path}`));

/** Fixture nhỏ đủ cho mọi endpoint có dữ liệu để đọc. */
function seed(service: SpyService): void {
  const store = service.store;
  store.upsertTopic({
    topicId: TOPIC, label: 'POV Finance', market: 'us', language: 'en', region: 'US',
  });
  // Kênh active (follow list) + kênh new (inbox) có suggestion.
  store.upsertTopicChannelCandidate({
    topicId: TOPIC, channelId: CH_ACTIVE, title: 'Active Chan',
    handle: '@active', subscriberCount: 120_000, discoveredVia: 'seed',
  });
  store.decideChannel(TOPIC, CH_ACTIVE, 'active', 'seed');
  store.updateChannelBaseline(TOPIC, CH_ACTIVE, {
    baselineMedianViews: 10_000, baselineN: 20, maxViews: 80_000,
    lastPublishedAt: '2026-09-20T00:00:00.000Z', lastCheckedAt: '2026-09-25T00:00:00.000Z',
  });
  store.upsertTopicChannelCandidate({
    topicId: TOPIC, channelId: CH_NEW, title: 'Inbox Chan',
    discoveredVia: 'weekly_outlier', discoveredFrom: 'old_money',
  });
  store.setChannelSuggestion(TOPIC, CH_NEW, 'pause_silent');
  // Keyword pending + active.
  store.upsertKeywordCandidate({
    topicId: TOPIC, termKey: 'old_money', displayTerm: 'old money',
    origin: 'title_ngram', evidenceJson: '{"n_channels":4,"sample_video_ids":["v1","v2"]}',
  });
  store.upsertKeywordCandidate({
    topicId: TOPIC, termKey: 'index_funds', displayTerm: 'index funds',
    origin: 'seed', evidenceJson: '{}',
  });
  store.decideKeyword(TOPIC, 'index_funds', 'active', 'seed');
  store.updateKeywordCheck(TOPIC, 'index_funds', {
    lastCheckedAt: '2026-09-24T00:00:00.000Z',
    lastNResults: 20, lastNFollowed: 5, lastMedianViews: 8_000,
  });
  // Video + 2 snapshot để views_gained_24h có số.
  store.upsertTopicVideo({
    topicId: TOPIC, videoId: VID, channelId: CH_ACTIVE, title: 'Big Video',
    publishedAt: '2026-09-18T00:00:00.000Z', durationSec: 600,
    source: 'setup', views: 50_000, capturedAt: '2026-09-24T00:00:00.000Z',
  });
  store.recordVideoDailyView({
    topicId: TOPIC, videoId: VID, day: '2026-09-24',
    views: 50_000, capturedAt: '2026-09-24T00:00:00.000Z',
  });
  store.recordVideoDailyView({
    topicId: TOPIC, videoId: VID, day: '2026-09-25',
    views: 55_000, likes: 1_000, capturedAt: '2026-09-25T00:00:00.000Z',
  });
  store.updateVideoDerived(TOPIC, VID, { viewsGained24h: 5_000, outlierScore: 5.5 });
  // Tick daily + weekly + report.
  store.createLoopTick({
    tickId: randomUUID(), topicId: TOPIC, quotaDay: '2026-09-25', mode: 'daily',
  });
  store.createLoopTick({
    tickId: randomUUID(), topicId: TOPIC, quotaDay: '2026-09-25', mode: 'weekly',
  });
  store.insertDailyReportOnce({
    reportId: randomUUID(), topicId: TOPIC, reportDate: '2026-09-25',
    summaryJson: '{"views_gained_24h":5000}', markdown: '# report', mode: 'daily',
  });
  store.addQuotaUsage('search', '2026-09-25', 3, 3);
  store.addQuotaUsage('general', '2026-09-25', 120, 2);
}

describe('Spy Dashboard API — 16 endpoint', () => {
  test('#1 /meta trả định nghĩa chỉ số + enum + ngưỡng mặc định', async () => {
    const { service, handler } = await boot();
    seed(service);
    const res = await get(handler, '/meta');
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { metrics: unknown[]; enums: { tick_mode: string[] } }; meta: { as_of: string } };
    expect(Array.isArray(body.data.metrics)).toBe(true);
    expect(body.data.enums.tick_mode).toEqual(['setup', 'daily', 'weekly']);
    expect(typeof body.meta.as_of).toBe('string');
  });

  test('#2 /topics trả topic kèm đếm + nhịp cuối theo mode', async () => {
    const { service, handler } = await boot();
    seed(service);
    const res = await get(handler, '/topics');
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<Record<string, unknown>> };
    const t = body.data.find((r) => r['topic_id'] === TOPIC)!;
    expect(t['channels_active']).toBe(1);
    expect(t['keywords_active']).toBe(1);
    expect(t['videos_tracked']).toBe(1);
    // 1 kênh new + 1 keyword pending + 1 suggestion (của chính kênh new đó).
    expect(t['inbox_pending']).toBe(3);
    expect(t['last_daily_at']).not.toBeNull();
    expect(t['last_weekly_at']).not.toBeNull();
  });

  test('#3 /overview trả envelope; thiếu topic_id → 400; topic lạ → 404', async () => {
    const { service, handler } = await boot();
    seed(service);
    const res = await get(handler, `/overview?topic_id=${TOPIC}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { date: string }; meta: { topic_id: string } };
    expect(typeof body.data.date).toBe('string');
    expect(body.meta.topic_id).toBe(TOPIC);
    expect((await get(handler, '/overview')).status).toBe(400);
    expect((await get(handler, '/overview?topic_id=nope')).status).toBe(404);
  });

  test('#4 /channels trả kênh kèm chỉ số baseline + sort whitelist + 400 sort lạ', async () => {
    const { service, handler } = await boot();
    seed(service);
    const res = await get(handler, `/channels?topic_id=${TOPIC}&status=active`);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<Record<string, unknown>>; meta: { total: number } };
    expect(body.meta.total).toBe(1);
    const ch = body.data[0]!;
    expect(ch['channel_id']).toBe(CH_ACTIVE);
    expect(ch['baseline_median_views']).toBe(10_000);
    expect(ch['baseline_reliable']).toBe(true);
    expect(ch['max_over_median']).toBe(8);
    expect(ch['is_lottery']).toBe(false);
    expect(ch['is_dead']).toBe(false);
    expect(ch['videos_tracked']).toBe(1);
    expect((await get(handler, `/channels?topic_id=${TOPIC}&sort=hacker`)).status).toBe(400);
  });

  test('#5 /channels/:id trả chi tiết + recent_videos + decisions; id lạ → 404', async () => {
    const { service, handler } = await boot();
    seed(service);
    const res = await get(handler, `/channels/${CH_ACTIVE}?topic_id=${TOPIC}`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: { channel: { channel_id: string }; recent_videos: unknown[]; decisions: unknown[] };
    };
    expect(body.data.channel.channel_id).toBe(CH_ACTIVE);
    expect(body.data.recent_videos.length).toBe(1);
    expect(body.data.decisions.length).toBeGreaterThan(0);
    expect((await get(handler, `/channels/UCnope?topic_id=${TOPIC}`)).status).toBe(404);
  });

  test('#6 /channels/:id/timeseries trả envelope list (stub B)', async () => {
    const { service, handler } = await boot();
    seed(service);
    const res = await get(handler, `/channels/${CH_ACTIVE}/timeseries?topic_id=${TOPIC}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: unknown[]; meta: { from: string; to: string } };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.meta.from).toBeDefined();
  });

  test('#7 /keywords trả keyword + pct_followed + channels_discovered + evidence', async () => {
    const { service, handler } = await boot();
    seed(service);
    const res = await get(handler, `/keywords?topic_id=${TOPIC}&status=active`);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<Record<string, unknown>> };
    const kw = body.data.find((k) => k['term_key'] === 'index_funds')!;
    expect(kw['pct_followed']).toBe(0.25);
    expect(kw['last_median_views']).toBe(8_000);
    const pend = await get(handler, `/keywords?topic_id=${TOPIC}&status=pending`);
    const pb = await pend.json() as { data: Array<Record<string, unknown>> };
    const pk = pb.data.find((k) => k['term_key'] === 'old_money')!;
    // old_money là discovered_from của kênh inbox → channels_discovered = 1.
    expect(pk['channels_discovered']).toBe(1);
    expect((pk['evidence'] as { n_channels: number })['n_channels']).toBe(4);
  });

  test('#8 /videos trả envelope list (stub B) + validate sort', async () => {
    const { service, handler } = await boot();
    seed(service);
    const res = await get(handler, `/videos?topic_id=${TOPIC}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: unknown[]; meta: { total: number } };
    expect(Array.isArray(body.data)).toBe(true);
    expect((await get(handler, `/videos?topic_id=${TOPIC}&sort=bad`)).status).toBe(400);
  });

  test('#9 /videos/:id/timeseries trả envelope list (stub B)', async () => {
    const { service, handler } = await boot();
    seed(service);
    const res = await get(handler, `/videos/${VID}/timeseries?topic_id=${TOPIC}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
  });

  test('#10 /hot trả envelope list + validate limit', async () => {
    const { service, handler } = await boot();
    seed(service);
    const res = await get(handler, `/hot?topic_id=${TOPIC}&date=2026-09-25`);
    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json() as { data: unknown[] }).data)).toBe(true);
    expect((await get(handler, `/hot?topic_id=${TOPIC}&limit=abc`)).status).toBe(400);
  });

  test('#11 /outliers trả envelope list; scope sai → 400', async () => {
    const { service, handler } = await boot();
    seed(service);
    const res = await get(handler, `/outliers?topic_id=${TOPIC}`);
    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json() as { data: unknown[] }).data)).toBe(true);
    expect((await get(handler, `/outliers?topic_id=${TOPIC}&scope=weird`)).status).toBe(400);
  });

  test('#12 /timeseries: metric bắt buộc + whitelist + group_by', async () => {
    const { service, handler } = await boot();
    seed(service);
    expect((await get(handler, `/timeseries?topic_id=${TOPIC}`)).status).toBe(400);
    expect((await get(handler, `/timeseries?topic_id=${TOPIC}&metric=bad`)).status).toBe(400);
    const res = await get(handler, `/timeseries?topic_id=${TOPIC}&metric=views_gained&group_by=week`);
    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json() as { data: unknown[] }).data)).toBe(true);
  });

  test('#13 /inbox trả 3 nhóm + counts', async () => {
    const { service, handler } = await boot();
    seed(service);
    const res = await get(handler, `/inbox?topic_id=${TOPIC}`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: {
        channels_new: unknown[]; keywords_pending: unknown[];
        channels_suggested: unknown[]; counts: Record<string, number>;
      };
    };
    expect(body.data.channels_new.length).toBe(1);
    expect(body.data.keywords_pending.length).toBe(1);
    expect(body.data.channels_suggested.length).toBe(1);
    expect(body.data.counts).toEqual({ channels: 1, keywords: 1, suggestions: 1 });
  });

  test('#14 /decisions trả audit log + summary.hitl_violations = 0', async () => {
    const { service, handler } = await boot();
    seed(service);
    const res = await get(handler, `/decisions?topic_id=${TOPIC}`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: Array<Record<string, unknown>>;
      meta: { summary: { by_actor: { human: number; loop: number }; hitl_violations: number } };
    };
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.meta.summary.hitl_violations).toBe(0);
    // decideChannel/decideKeyword (human) + upsert*Candidate (loop) đều có mặt.
    expect(body.meta.summary.by_actor.human).toBeGreaterThan(0);
    expect(body.meta.summary.by_actor.loop).toBeGreaterThan(0);
    const d = body.data.find((r) => r['entity_type'] === 'keyword' && r['actor'] === 'human')!;
    expect(d['entity_label']).toBe('index funds');
    // Filter actor=loop → chỉ dòng máy.
    const loop = await get(handler, `/decisions?topic_id=${TOPIC}&actor=loop`);
    const lb = await loop.json() as { data: Array<Record<string, unknown>> };
    expect(lb.data.every((r) => r['actor'] === 'loop')).toBe(true);
  });

  test('#15 /ticks trả tick theo mode + khoảng ngày', async () => {
    const { service, handler } = await boot();
    seed(service);
    const res = await get(handler, `/ticks?topic_id=${TOPIC}&mode=weekly`);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<Record<string, unknown>>; meta: { total: number } };
    expect(body.meta.total).toBe(1);
    expect(body.data[0]!['mode']).toBe('weekly');
    const all = await get(handler, `/ticks?topic_id=${TOPIC}`);
    expect((await all.json() as { meta: { total: number } }).meta.total).toBe(2);
    expect((await get(handler, `/ticks?topic_id=${TOPIC}&mode=bogus`)).status).toBe(400);
  });

  test('#16 /reports trả report theo mode; /quota trả sổ quota theo ngày', async () => {
    const { service, handler } = await boot();
    seed(service);
    const res = await get(handler, `/reports?topic_id=${TOPIC}&mode=daily`);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<Record<string, unknown>> };
    expect(body.data[0]!['report_date']).toBe('2026-09-25');
    expect((body.data[0]!['summary'] as Record<string, unknown>)['views_gained_24h']).toBe(5_000);
    // /quota không cần topic_id.
    const q = await get(handler, '/quota?from=2026-09-20&to=2026-09-25');
    expect(q.status).toBe(200);
    const qb = await q.json() as { data: Array<Record<string, unknown>> };
    expect(qb.data.length).toBe(2);
    expect(qb.data.every((r) => r['quota_day'] === '2026-09-25')).toBe(true);
  });

  test('format=csv trả CSV số thô; method != GET → 405; limit >500 → 400', async () => {
    const { service, handler } = await boot();
    seed(service);
    const csv = await get(handler, `/channels?topic_id=${TOPIC}&format=csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    const text = await csv.text();
    expect(text.split('\n')[0]).toContain('channel_id');
    expect(text).toContain(CH_ACTIVE);
    // POST bị chặn ngay từ mount.
    const post = await handler(new Request(`http://127.0.0.1:4187/api/spy/dash/channels?topic_id=${TOPIC}`, { method: 'POST' }));
    expect(post.status).toBe(405);
    expect((await get(handler, `/channels?topic_id=${TOPIC}&limit=501`)).status).toBe(400);
    expect((await get(handler, '/dash-unknown')).status).toBe(404);
  });

  test('M2: format=csv có ở /topics + channel/video timeseries', async () => {
    const { service, handler } = await boot();
    seed(service);
    for (const path of [
      '/topics',
      `/channels/${CH_ACTIVE}/timeseries?topic_id=${TOPIC}`,
      `/videos/${VID}/timeseries?topic_id=${TOPIC}`,
    ]) {
      const res = await get(handler, `${path}${path.includes('?') ? '&' : '?'}format=csv`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/csv');
    }
  });

  test('M1 (bug lớp mới, đã sửa): /timeseries dùng cận trên UTC-hôm-nay, không phải quota_day', async () => {
    // /timeseries gộp 6 metric có khoá ngày khác nhau: views_gained/search_calls
    // dựa trên cột đã bucket theo quota_day (Pacific luôn <= UTC nên UTC-hôm-nay
    // vẫn là cận trên an toàn cho chúng); new_channels/approvals/outliers dựa
    // trên substr(mốc thời gian thật, 1, 10). Nếu cận trên vẫn là quota_day
    // Pacific, một quyết định/video ghi trong ~7-8h UTC-đã-sang-ngày-mới-nhưng-
    // Pacific-chưa sẽ biến mất khỏi kết quả — sự cố thật đo được lúc
    // 2026-09-26 02:21Z: quotaDay()='2026-09-25', một decisions.at ghi ngay
    // lúc đó bị loại khỏi /decisions. Cận trên đúng cho MỌI metric dùng
    // chung route là UTC-hôm-nay.
    const { service, handler } = await boot();
    seed(service);
    const res = await get(handler, `/timeseries?topic_id=${TOPIC}&metric=views_gained`);
    const body = (await res.json()) as { meta: { from: string; to: string } };
    expect(body.meta.to).toBe(new Date().toISOString().slice(0, 10));
    // Bản thân quotaDay lệch UTC tại biên: 05:00Z mùa hè = 22:00 Pacific
    // ngày hôm trước → quota-day là ngày trước, UTC-day là ngày sau. Đây
    // chính là độ lệch khiến quota_day không dùng được làm cận trên chung.
    expect(quotaDay(new Date('2026-09-25T05:00:00Z'))).toBe('2026-09-24');
  });

  test('L1: csv chặn formula injection + escape CR', async () => {
    const { service, handler } = await boot();
    seed(service);
    service.store.upsertTopicChannel({
      topicId: TOPIC, channelId: 'UCevil000000000000003', title: '=1+2|cmd',
      status: 'active',
    });
    const res = await get(handler, `/channels?topic_id=${TOPIC}&format=csv`);
    const text = await res.text();
    // Ô bắt đầu '=' phải được tiền tố ' để Excel/Sheets không parse công thức.
    expect(text).toContain("'=1+2|cmd");
    expect(text).not.toContain(',=1+2|cmd');
  });
});
