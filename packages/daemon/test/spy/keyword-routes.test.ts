/**
 * Spy Keyword Run API (v14, plan spy-keyword-run-board §2) + dash mở rộng —
 * test đi qua ROUTE THẬT (`createHandler` + HttpApp) trên DB test trong tmpdir,
 * dataApi là FakeDataApi (cùng pattern loop-modes.test.ts).
 *
 * POST /api/spy/keywords/bulk   — add nhiều keyword một lần (idempotent).
 * POST /api/spy/keywords/decide — quyết định người trên nhiều term_key.
 * POST /api/spy/keywords/run    — search theo yêu cầu, chạy nền, ghi runs/items.
 * GET  /api/spy/keywords/runs[/:id] — lịch sử run cho board.
 * GET  /api/spy/dash/* mở rộng — group_key, outliers_7d/28d, videos_found,
 *         prev_median_views, filter group=/keyword=, /keywords/:term_key,
 *         /keyword-runs.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SpyService,
  quotaDay,
  type ChannelStatistics,
  type PlaylistVideoItem,
  type SearchHit,
  type SearchInput,
  type VideoStatistics,
  type YouTubeDataApiPort,
} from '@writer-room/spy';
import { createHandler, type HttpApp } from '../../src/http.ts';

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
  hitsByQuery = new Map<string, SearchHit[]>();
  hitsForAll: SearchHit[] | null = null;
  videosByChannel = new Map<string, FakeVideo[]>();
  channelsMeta = new Map<string, Partial<ChannelStatistics>>();
  /** Hook sau mỗi search — test dùng để mô phỏng quota cạn giữa run. */
  onSearch?: (input: SearchInput) => void;

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
          publishedAt: video.publishedAt ?? '2026-09-10T00:00:00.000Z',
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
    this.onSearch?.(input);
    return { hits: this.hitsForAll ?? this.hitsByQuery.get(input.q ?? '') ?? [], nextPageToken: null };
  }
}

let root = '';
let spy: SpyService | undefined;

afterEach(async () => {
  spy?.store.close();
  spy = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

const TOPIC = 'fin';

async function boot(): Promise<{
  service: SpyService;
  dataApi: FakeDataApi;
  handler: (req: Request) => Promise<Response>;
}> {
  root = await mkdtemp(join(tmpdir(), 'writer-room-kwr-'));
  const dataApi = new FakeDataApi();
  const service = new SpyService({ dataRoot: join(root, 'spy'), dataApi });
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
  service.store.upsertTopic({
    topicId: TOPIC, label: 'Finance VI', market: 'vi', language: 'vi', region: 'VN',
  });
  return { service, dataApi, handler: createHandler(app) };
}

const post = (
  handler: (r: Request) => Promise<Response>,
  path: string,
  body: unknown,
) => handler(new Request(`http://127.0.0.1:4187/api/spy/keywords${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}));

const get = (handler: (r: Request) => Promise<Response>, path: string) =>
  handler(new Request(`http://127.0.0.1:4187${path}`));

/** Poll run tới khi ra khỏi 'running' (execute chạy nền). */
async function waitRun(service: SpyService, runId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 200; i++) {
    const got = service.store.getKeywordRun(runId);
    if (got && got.run['status'] !== 'running') return got.run;
    await Bun.sleep(10);
  }
  throw new Error(`run ${runId} không kết thúc sau 2s`);
}

function keywordStatus(service: SpyService, termKey: string): string {
  // listTopicKeywords trả raw row; listKeywordsByStatus trả TopicKeywordRow đã map.
  const kw = service.store.listKeywordsByStatus(TOPIC, ['pending', 'active', 'paused', 'rejected'])
    .find((k) => k.termKey === termKey);
  if (!kw) throw new Error(`keyword ${termKey} không tồn tại`);
  return kw.status;
}

/** Kênh ngoài follow khoẻ mạnh: n video 1k views + 1 hit 10k (outlier 10x ≥ 3). */
function seedOutsideChannel(dataApi: FakeDataApi, channelId: string, hitViews = 10_000): void {
  dataApi.videosByChannel.set(channelId, [
    ...Array.from({ length: 12 }, (_, i) => ({
      videoId: `${channelId}v${i}`,
      title: `vay trả góp số ${i}`,
      views: 1_000,
      durationSec: 600,
      defaultAudioLanguage: 'vi' as const,
      publishedAt: new Date(Date.parse('2026-08-20T00:00:00.000Z') - i * 86_400_000).toISOString(),
    })),
    // Hit publish hôm qua → nằm trong cả cửa sổ outliers_7d lẫn _28d của dash.
    { videoId: 'hit1', title: 'vay trả góp siêu nổ', views: hitViews, durationSec: 600,
      defaultAudioLanguage: 'vi', publishedAt: new Date(Date.now() - 86_400_000).toISOString() },
  ]);
  dataApi.hitsForAll = [{
    kind: 'video', videoId: 'hit1', channelId,
    title: 'vay trả góp siêu nổ', description: null,
    channelTitle: `Kênh ${channelId}`,
    publishedAt: new Date(Date.now() - 86_400_000).toISOString(), thumbnailUrl: null,
  }];
}

describe('POST /keywords/bulk', () => {
  test('add nhiều keyword → pending origin=user group_key; idempotent lần 2', async () => {
    const { service, handler } = await boot();
    const res = await post(handler, '/bulk', {
      topicId: TOPIC,
      terms: ['vay trả góp', 'Thẻ Tín Dụng', 'vay trả góp', '   '],
      group: 'vay-tin-dung',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      added: string[]; reactivated: string[]; skipped: Array<{ term: string; reason: string }>;
    };
    // 'vay trả góp' lần 2 là dup trong payload → skipped; '   ' → invalid.
    expect(body.added.sort()).toEqual(['the_tin_dung', 'vay_tra_gop'].sort());
    expect(body.skipped.length).toBe(2);

    const kws = service.store.listKeywordsByStatus(TOPIC, ['pending', 'active', 'paused', 'rejected']);
    expect(kws.length).toBe(2);
    expect(kws.every((k) => k.status === 'pending' && k.origin === 'user' && k.addedBy === 'user')).toBe(true);
    expect(kws.every((k) => k.groupKey === 'vay-tin-dung')).toBe(true);

    // Lần 2: cùng payload → không thêm, không phá status — mọi thứ skipped.
    const res2 = await post(handler, '/bulk', {
      topicId: TOPIC, terms: ['vay trả góp', 'Thẻ Tín Dụng'], group: 'vay-tin-dung',
    });
    const body2 = await res2.json() as { added: string[]; skipped: unknown[] };
    expect(body2.added).toEqual([]);
    expect(body2.skipped.length).toBe(2);
    expect(service.store.listKeywordsByStatus(TOPIC, ['pending']).length).toBe(2);
  });

  test('activate=true → active + decisions actor=human; re-add rejected → pending', async () => {
    const { service, handler } = await boot();
    const res = await post(handler, '/bulk', {
      topicId: TOPIC, terms: ['a x', 'b y'], activate: true, reason: 'tôi duyệt',
    });
    expect(res.status).toBe(200);
    expect(keywordStatus(service, 'a_x')).toBe('active');
    expect(keywordStatus(service, 'b_y')).toBe('active');
    const decisions = service.store.listDecisions(TOPIC, { entityType: 'keyword' });
    expect(decisions.every((d) => d.actor === 'human' && d.toStatus === 'active')).toBe(true);

    // Re-add keyword rejected không activate → đưa về pending qua decideKeyword.
    service.store.decideKeyword(TOPIC, 'a_x', 'rejected', 'test reject');
    const res2 = await post(handler, '/bulk', { topicId: TOPIC, terms: ['a x'] });
    const body2 = await res2.json() as { reactivated: string[] };
    expect(body2.reactivated).toEqual(['a_x']);
    expect(keywordStatus(service, 'a_x')).toBe('pending');
  });

  test('thiếu topicId/terms → 400; topic lạ → 404', async () => {
    const { handler } = await boot();
    expect((await post(handler, '/bulk', { terms: ['a'] })).status).toBe(400);
    expect((await post(handler, '/bulk', { topicId: TOPIC, terms: [] })).status).toBe(400);
    expect((await post(handler, '/bulk', { topicId: 'nope', terms: ['a'] })).status).toBe(404);
  });
});

describe('POST /keywords/decide', () => {
  test('decide nhiều term → status đổi + decisions; validate 400', async () => {
    const { service, handler } = await boot();
    await post(handler, '/bulk', { topicId: TOPIC, terms: ['a x', 'b y'] });
    const res = await post(handler, '/decide', {
      topic_id: TOPIC, term_keys: ['a_x', 'b_y'], to_status: 'paused', reason: 'tạm dừng',
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { updated: number }).updated).toBe(2);
    expect(keywordStatus(service, 'a_x')).toBe('paused');
    expect(keywordStatus(service, 'b_y')).toBe('paused');

    expect((await post(handler, '/decide', {
      topic_id: TOPIC, term_keys: ['a_x'], to_status: 'weird',
    })).status).toBe(400);
    expect((await post(handler, '/decide', {
      topic_id: TOPIC, term_keys: ['khong_co'], to_status: 'active',
    })).status).toBe(400);
  });
});

describe('POST /keywords/run', () => {
  test('dryRun → estimate + quotaRemaining, KHÔNG tạo run', async () => {
    const { service, handler } = await boot();
    await post(handler, '/bulk', { topicId: TOPIC, terms: ['a', 'b'], activate: true });
    const res = await post(handler, '/run', { topicId: TOPIC, dryRun: true });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      dryRun: boolean; keywords: string[]; estimatedSearchCalls: number; quotaRemaining: number;
    };
    expect(body.dryRun).toBe(true);
    expect(body.keywords.sort()).toEqual(['a', 'b']);
    expect(body.estimatedSearchCalls).toBe(2);
    expect(body.quotaRemaining).toBe(100);
    expect(service.store.listKeywordRuns(TOPIC).length).toBe(0);
  });

  test('run thật: kênh ngoài được đo → new, items + checks đúng', async () => {
    const { service, dataApi, handler } = await boot();
    seedOutsideChannel(dataApi, 'UCoutside');
    await post(handler, '/bulk', { topicId: TOPIC, terms: ['vay trả góp'], activate: true });

    const res = await post(handler, '/run', { topicId: TOPIC, scanChannelsCap: 5 });
    expect(res.status).toBe(200);
    const { runId } = await res.json() as { runId: string };
    const run = await waitRun(service, runId);

    expect(run['status']).toBe('done');
    expect(run['keywords_done']).toBe(1);
    expect(run['new_candidates']).toBe(1);
    expect(run['search_calls_used']).toBe(1);

    const detail = service.store.getKeywordRun(runId)!;
    const item = detail.items.find((i) => i['term_key'] === 'vay_tra_gop')!;
    expect(item['status']).toBe('done');
    expect(item['n_results']).toBe(1);

    // hit1 vào sổ ngay lúc search (source giữ nguồn đầu tiên = keyword_run), rồi
    // lượt quét uploads của kênh ngoài thấy nó → được tính baseline.
    const video = service.store.listTopicVideos(TOPIC, {}).find((v) => v.videoId === 'hit1')!;
    expect(video.source).toBe('keyword_run');
    expect(video.foundByKeyword).toBe('vay_tra_gop');
    expect(video.baselineEligible).toBe(true);
    // Lượt đo được ghi sổ measured_channels, nguồn là keyword_run.
    const measured = service.store.listMeasuredChannels(TOPIC);
    expect(measured.map((m) => [m.channelId, m.verdict, m.discoveredVia]))
      .toEqual([['UCoutside', 'proposed', 'keyword_run']]);
    // Kênh ngoài follow được quét → đề xuất 'new' (HITL: loop chỉ ghi new).
    const ch = service.store.listTopicChannelsByStatus(TOPIC, ['new'])[0]!;
    expect(ch.channelId).toBe('UCoutside');
    expect(ch.discoveredFrom).toBe('vay_tra_gop');
    // keyword_checks append-only ghi kèm run_id.
    const checks = service.store.listKeywordChecks(TOPIC, 'vay_tra_gop');
    expect(checks.length).toBe(1);
    expect(checks[0]!['run_id']).toBe(runId);
    // hitl_violations = 0 — không dòng decisions actor=loop nào ghi active.
    const decisions = service.store.listDecisions(TOPIC, {});
    expect(decisions.filter((d) => d.actor === 'loop' && (d.toStatus === 'active' || d.toStatus === 'paused'))).toEqual([]);
  });

  test('hết quota giữa chừng → item skipped_quota, run status skipped_quota', async () => {
    const { service, dataApi, handler } = await boot();
    await post(handler, '/bulk', { topicId: TOPIC, terms: ['a', 'b'], activate: true });
    // Preflight cần remaining ≥ n=2 → dùng 98 để qua gate. Consumer khác hút
    // cạn sau search đầu → keyword thứ hai thấy remaining=0 → skipped_quota.
    service.store.addQuotaUsage('search', quotaDay(), 98, 98);
    dataApi.hitsForAll = [];
    dataApi.onSearch = () => {
      service.store.addQuotaUsage('search', quotaDay(), 1, 1);
    };

    const res = await post(handler, '/run', { topicId: TOPIC });
    const { runId } = await res.json() as { runId: string };
    const run = await waitRun(service, runId);

    expect(run['status']).toBe('skipped_quota');
    const items = service.store.getKeywordRun(runId)!.items;
    const statuses = new Map(items.map((i) => [i['term_key'], i['status']]));
    expect([...statuses.values()].sort()).toEqual(['done', 'skipped_quota']);
  });

  test('preflight: quota không đủ → 429; topic paused → 409; run đang chạy → 409; topic lạ → 404', async () => {
    const { service, handler } = await boot();
    await post(handler, '/bulk', { topicId: TOPIC, terms: ['a', 'b'], activate: true });

    // quota: cần 2, còn 1 → 429 kèm remaining.
    service.store.addQuotaUsage('search', quotaDay(), 99, 99);
    const r429 = await post(handler, '/run', { topicId: TOPIC });
    expect(r429.status).toBe(429);
    const b429 = await r429.json() as { error: string; remaining: number };
    expect(b429.remaining).toBe(1);
    expect(service.store.listKeywordRuns(TOPIC).length).toBe(0);
    // Trả quota lại cho các case sau.
    service.store.rawDb.prepare("UPDATE api_quota_usage SET units=0, calls=0 WHERE bucket='search'").run();

    // topic paused → 409.
    service.store.rawDb.prepare("UPDATE topics SET status='paused' WHERE topic_id=?").run(TOPIC);
    expect((await post(handler, '/run', { topicId: TOPIC })).status).toBe(409);
    service.store.rawDb.prepare("UPDATE topics SET status='active' WHERE topic_id=?").run(TOPIC);

    // run đang 'running' (dựng tay) → 409.
    service.store.createKeywordRun({
      runId: 'busy', topicId: TOPIC, paramsJson: '{}', nKeywords: 1,
      startedAt: new Date().toISOString(),
    });
    expect((await post(handler, '/run', { topicId: TOPIC })).status).toBe(409);

    expect((await post(handler, '/run', { topicId: 'nope' })).status).toBe(404);
    // Không keyword nào khớp → 400.
    expect((await post(handler, '/run', { topicId: TOPIC, termKeys: ['khong_co'] })).status).toBe(400);
  });

  test('GET runs + runs/:runId trả lịch sử kèm items', async () => {
    const { service, dataApi, handler } = await boot();
    dataApi.hitsForAll = [];
    await post(handler, '/bulk', { topicId: TOPIC, terms: ['a'], activate: true });
    const res = await post(handler, '/run', { topicId: TOPIC });
    const { runId } = await res.json() as { runId: string };
    await waitRun(service, runId);

    const list = await get(handler, `/api/spy/keywords/runs?topic_id=${TOPIC}`);
    expect(list.status).toBe(200);
    const lb = await list.json() as { runs: Array<Record<string, unknown>> };
    expect(lb.runs.length).toBe(1);
    expect(lb.runs[0]!['run_id']).toBe(runId);
    expect(lb.runs[0]!['status']).toBe('done');

    const one = await get(handler, `/api/spy/keywords/runs/${runId}`);
    expect(one.status).toBe(200);
    const ob = await one.json() as { items: Array<Record<string, unknown>>; params: Record<string, unknown> };
    expect(ob.items.length).toBe(1);
    expect(ob.items[0]!['term_key']).toBe('a');
    expect(ob.params['maxResults']).toBe(50);

    expect((await get(handler, '/api/spy/keywords/runs/nope')).status).toBe(404);
    expect((await get(handler, '/api/spy/keywords/runs')).status).toBe(400);
  });
});

describe('dash mở rộng v14', () => {
  test('/dash/keywords: group_key, videos_found, outliers_28d, prev_median_views, filter group', async () => {
    const { service, dataApi, handler } = await boot();
    seedOutsideChannel(dataApi, 'UCoutside');
    await post(handler, '/bulk', {
      topicId: TOPIC, terms: ['vay trả góp', 'thẻ tín dụng'], group: 'vay', activate: true,
    });
    // Check CŨ hơn để prev_median_views có dữ liệu (rn=2).
    service.store.updateKeywordCheck(TOPIC, 'vay_tra_gop', {
      lastCheckedAt: '2026-09-20T00:00:00.000Z', lastNResults: 8, lastNFollowed: 1, lastMedianViews: 321,
    });
    // Hit của kênh ngoài có outlier_score — ghi tay để /outliers + đếm khớp.
    const res = await post(handler, '/run', { topicId: TOPIC, termKeys: ['vay_tra_gop'] });
    const { runId } = await res.json() as { runId: string };
    await waitRun(service, runId);
    // Gán outlier_score cho video run tìm được (score thật do updateVideoDerived).
    service.store.updateVideoDerived(TOPIC, 'hit1', { viewsGained24h: null, outlierScore: 10 });

    const kw = await get(handler, `/api/spy/dash/keywords?topic_id=${TOPIC}`);
    const kb = await kw.json() as { data: Array<Record<string, unknown>> };
    const row = kb.data.find((k) => k['term_key'] === 'vay_tra_gop')!;
    expect(row['group_key']).toBe('vay');
    expect(row['videos_found']).toBe(1);
    expect(row['outliers_28d']).toBe(1);
    expect(row['outliers_7d']).toBe(1);
    expect(row['prev_median_views']).toBe(321);

    // Filter group + keyword khác nhóm → không lọt.
    const gf = await get(handler, `/api/spy/dash/keywords?topic_id=${TOPIC}&group=vay`);
    const gb = await gf.json() as { data: Array<Record<string, unknown>> };
    expect(gb.data.length).toBe(2);
    const gf2 = await get(handler, `/api/spy/dash/keywords?topic_id=${TOPIC}&group=khac`);
    expect((await gf2.json() as { data: unknown[] }).data.length).toBe(0);
    // Sort outliers_28d trong whitelist.
    expect((await get(handler, `/api/spy/dash/keywords?topic_id=${TOPIC}&sort=outliers_28d`)).status).toBe(200);

    // /outliers?keyword= chỉ giữ video của keyword đó.
    const ol = await get(handler, `/api/spy/dash/outliers?topic_id=${TOPIC}&keyword=vay_tra_gop`);
    const ob = await ol.json() as { data: Array<Record<string, unknown>> };
    expect(ob.data.length).toBe(1);
    expect(ob.data[0]!['found_by_keyword']).toBe('vay_tra_gop');
    const ol2 = await get(handler, `/api/spy/dash/outliers?topic_id=${TOPIC}&keyword=the_tin_dung`);
    expect((await ol2.json() as { data: unknown[] }).data.length).toBe(0);

    // /keywords/:term_key — detail + checks + top_videos.
    const det = await get(handler, `/api/spy/dash/keywords/vay_tra_gop?topic_id=${TOPIC}`);
    expect(det.status).toBe(200);
    const db = await det.json() as {
      data: { checks: Array<Record<string, unknown>>; top_videos: Array<Record<string, unknown>> };
    };
    expect(db.data.checks.length).toBe(2);
    expect(db.data.checks[0]!['run_id']).toBe(runId);
    expect(db.data.top_videos[0]!['video_id']).toBe('hit1');
    expect((await get(handler, `/api/spy/dash/keywords/nope?topic_id=${TOPIC}`)).status).toBe(404);

    // /dash/keyword-runs + /keyword-runs/:id.
    const runs = await get(handler, `/api/spy/dash/keyword-runs?topic_id=${TOPIC}`);
    const rb = await runs.json() as { data: Array<Record<string, unknown>> };
    expect(rb.data[0]!['run_id']).toBe(runId);
    const rd = await get(handler, `/api/spy/dash/keyword-runs/${runId}`);
    const rdb = await rd.json() as { data: { items: unknown[] } };
    expect(rdb.data.items.length).toBe(1);
    expect((await get(handler, `/api/spy/dash/keyword-runs/nope`)).status).toBe(404);

    // /meta có video_source keyword_run + keyword_run_status.
    const meta = await get(handler, '/api/spy/dash/meta');
    const mb = await meta.json() as { data: { enums: Record<string, string[]> } };
    expect(mb.data.enums['video_source']).toContain('keyword_run');
    expect(mb.data.enums['keyword_run_status']).toContain('skipped_quota');
  });
});

describe('POST /keywords/run — thẻ lượt chạy + chống trùng 3 ngày (plan spy-analyst-workflow §H bước 3)', () => {
  test('thẻ ghi note/group/triggered_by/n_new; keyword search < 3 ngày → skipped_dedup, không tốn search', async () => {
    const { service, dataApi, handler } = await boot();
    seedOutsideChannel(dataApi, 'UCoutside');
    await post(handler, '/bulk', { topicId: TOPIC, terms: ['vay trả góp', 'thẻ tín dụng'], group: 'vay', activate: true });
    // 'thẻ tín dụng' vừa search hôm qua → bị khoá.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    service.store.updateKeywordCheck(TOPIC, 'the_tin_dung', {
      lastCheckedAt: yesterday, lastNResults: 5, lastNFollowed: 0, lastMedianViews: 100,
    });

    const dry = await post(handler, '/run', { topicId: TOPIC, group: 'vay', dryRun: true });
    const db = await dry.json() as { estimatedSearchCalls: number; locked: Array<{ termKey: string }> };
    expect(db.estimatedSearchCalls).toBe(1);
    expect(db.locked.map((l) => l.termKey)).toEqual(['the_tin_dung']);

    const res = await post(handler, '/run', { topicId: TOPIC, group: 'vay', note: 'Tìm kênh nhỏ đang lên' });
    expect(res.status).toBe(200);
    const { runId } = await res.json() as { runId: string };
    const run = await waitRun(service, runId);

    expect(run['type']).toBe('discover');
    expect(run['note']).toBe('Tìm kênh nhỏ đang lên');
    expect(run['group_key']).toBe('vay');
    expect(run['triggered_by']).toBe('human');
    expect(run['search_calls_used']).toBe(1);
    expect(run['n_skipped']).toBe(1);
    expect(run['n_new']).toBe(1);
    expect(dataApi.searchCalls.length).toBe(1);

    const items = new Map(service.store.getKeywordRun(runId)!.items.map((i) => [String(i['term_key']), i]));
    expect(items.get('the_tin_dung')!['status']).toBe('skipped_dedup');
    expect(items.get('the_tin_dung')!['skip_reason']).toBe(`searched_at:${yesterday}`);
    expect(items.get('vay_tra_gop')!['n_new']).toBe(1);

    // Kênh ngoài vừa đo nhận ngách của keyword tìm ra nó + ngày tạo kênh.
    const measured = service.store.listMeasuredChannels(TOPIC)[0]!;
    expect(measured.groupKey).toBe('vay');
    expect(measured.channelPublishedAt).not.toBeNull();
    const ch = service.store.listTopicChannelsByStatus(TOPIC, ['new'])[0]!;
    expect(ch.groupKey).toBe('vay');
  });

  test('mọi keyword đều bị khoá 3 ngày → 409, không tạo lượt chạy', async () => {
    const { service, handler } = await boot();
    await post(handler, '/bulk', { topicId: TOPIC, terms: ['a'], activate: true });
    service.store.updateKeywordCheck(TOPIC, 'a', {
      lastCheckedAt: new Date().toISOString(), lastNResults: 1, lastNFollowed: 0, lastMedianViews: 1,
    });
    const res = await post(handler, '/run', { topicId: TOPIC });
    expect(res.status).toBe(409);
    expect(service.store.listKeywordRuns(TOPIC).length).toBe(0);
  });
});
