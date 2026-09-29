/**
 * board-routes.test.ts — /api/spy/board/* (plan spy-analyst-workflow §F):
 * validate tham số, 404 topic/run, gán ngách, và HTTP == MCP spy_board_* (cùng
 * hàm queries.ts → cùng data).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SpyService, spyTools } from '@writer-room/spy';
import { createHandler, type HttpApp } from '../../src/http.ts';

let root = '';
let spy: SpyService | undefined;
afterEach(async () => {
  spy?.store.close();
  spy = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

const T = 'fin';
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

async function boot() {
  root = await mkdtemp(join(tmpdir(), 'writer-room-board-'));
  const service = new SpyService({ dataRoot: join(root, 'spy') });
  await service.init();
  spy = service;
  const app: HttpApp = {
    spy: service, spyMcp: null, generalPackMcp: null,
    harness: {} as unknown as HttpApp['harness'],
    startedAt: Date.now(), webRoot: '', loopScheduler: null, loop: null,
  };
  const s = service.store;
  s.upsertTopic({ topicId: T, label: 'Fin', market: 'en', language: 'en', region: 'US' });
  s.upsertTopicKeyword({ topicId: T, termKey: 'vay', displayTerm: 'vay', relation: 'seed', status: 'active', groupKey: 'vay' });
  s.upsertTopicChannel({ topicId: T, channelId: 'A', status: 'active', title: 'A', subscriberCount: 4_000 });
  s.setTopicChannelMeta(T, 'A', { groupKey: 'vay', channelPublishedAt: daysAgo(100) });
  for (let i = 0; i < 12; i++) {
    s.upsertTopicVideo({
      topicId: T, videoId: `A${i}`, channelId: 'A', title: `A${i}`, publishedAt: daysAgo(10 + i),
      durationSec: 600, source: 'daily_scan', views: i === 0 ? 6_000 : 1_000, capturedAt: daysAgo(0),
    });
  }
  s.upsertMeasuredChannel({
    topicId: T, channelId: 'X', title: 'X', subscriberCount: 900, baselineMedianViews: null, baselineN: null,
    maxViews: null, verdict: 'unreliable', hitOutlierScore: null, discoveredVia: 'setup',
    discoveredFrom: null, measuredAt: daysAgo(1),
  });
  return { service, handler: createHandler(app) };
}

const get = (h: (r: Request) => Promise<Response>, path: string) =>
  h(new Request(`http://127.0.0.1:4187/api/spy/board/${path}`));
const post = (h: (r: Request) => Promise<Response>, path: string, body: unknown) =>
  h(new Request(`http://127.0.0.1:4187/api/spy/board/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));

function mcp(service: SpyService, name: string, args: Record<string, unknown>) {
  const tool = spyTools(service).find((t) => t.name === name)!;
  return tool.handler(args, { subject: 'test', scopes: new Set(['spy.read']) });
}

describe('/api/spy/board', () => {
  test('HTTP và MCP trả cùng data cho cùng tham số', async () => {
    const { service, handler } = await boot();
    const pairs: Array<[string, string, Record<string, unknown>]> = [
      ['scorecard', `scorecard?topic_id=${T}`, { topic_id: T }],
      ['videos', `videos?topic_id=${T}&niche=vay&view=outliers`, { topic_id: T, niche: 'vay', view: 'outliers' }],
      ['channels', `channels?topic_id=${T}&niche=vay&small_only=1`, { topic_id: T, niche: 'vay', small_only: true }],
      ['keywords', `keywords?topic_id=${T}&niche=vay`, { topic_id: T, niche: 'vay' }],
      ['runs', `runs?topic_id=${T}`, { topic_id: T }],
    ];
    for (const [name, path, args] of pairs) {
      const res = await get(handler, path);
      expect(res.status).toBe(200);
      const http = await res.json() as { data: unknown; dataAsOf: unknown; sample: unknown };
      const viaMcp = await mcp(service, `spy_board_${name}`, args) as { data: unknown; dataAsOf: unknown; sample: unknown };
      expect(http.data).toEqual(JSON.parse(JSON.stringify(viaMcp.data)));
      expect(http.sample).toEqual(viaMcp.sample);
    }
    const videos = await (await get(handler, `videos?topic_id=${T}&niche=vay`)).json() as { data: Array<Record<string, unknown>> };
    expect(videos.data.map((v) => [v['videoId'], v['tier'], v['outlierX']])).toEqual([['A0', 'reliable', 6]]);
  });

  test('niche=_none đọc kênh chưa gán; gán ngách rồi kênh chuyển sang ngách đó', async () => {
    const { handler } = await boot();
    const none = await (await get(handler, `channels?topic_id=${T}&niche=_none`)).json() as { data: Array<Record<string, unknown>> };
    expect(none.data.map((c) => c['channelId'])).toEqual(['X']);

    const res = await post(handler, 'channels/niche', { topicId: T, channelIds: ['X'], niche: 'vay' });
    expect(await res.json()).toEqual({ changed: 1 });
    const vay = await (await get(handler, `channels?topic_id=${T}&niche=vay`)).json() as { data: Array<Record<string, unknown>> };
    expect(vay.data.map((c) => c['channelId']).sort()).toEqual(['A', 'X']);
  });

  test('validate: thiếu topic 400, topic lạ 404, enum sai 400, run lạ 404, limit > 500 400', async () => {
    const { handler } = await boot();
    expect((await get(handler, 'scorecard')).status).toBe(400);
    expect((await get(handler, 'scorecard?topic_id=nope')).status).toBe(404);
    expect((await get(handler, `videos?topic_id=${T}&view=weird`)).status).toBe(400);
    expect((await get(handler, `videos?topic_id=${T}&limit=501`)).status).toBe(400);
    expect((await get(handler, 'runs/nope')).status).toBe(404);
    expect((await get(handler, `nope?topic_id=${T}`)).status).toBe(404);
    expect((await post(handler, 'channels/niche', { topicId: T, channelIds: [], niche: 'x' })).status).toBe(400);
  });
});
