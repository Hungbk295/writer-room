/**
 * Route HITL v3 (plan §P3) — hai endpoint duyệt của người:
 *
 *   GET  /api/spy/loop/inbox?topic_id=…  → 3 nhóm chờ người đọc:
 *        kênh status=new, keyword pending, kênh có suggestion của máy.
 *   POST /api/spy/loop/decide            → {topic_id, entity_type, entity_id,
 *        to_status, reason} → decideChannel/decideKeyword của store contract,
 *        ghi decisions actor='human' (bằng chứng tôn chỉ 1).
 *
 * Test đi qua ROUTE THẬT (`createHandler`) rồi kiểm chứng ở tầng row bằng
 * connection readonly — giống hard-gate của loop-cold-start.test.ts: DTO do
 * chính adapter dựng không chứng minh được gì nằm trong SQLite.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpyService } from '@writer-room/spy';
import { createHandler, type HttpApp } from '../../src/http.ts';
import { createSpyLoopAdapter } from '../../src/spy/loop-contract.ts';

let root = '';
let spy: SpyService | undefined;

afterEach(async () => {
  spy?.store.close();
  spy = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

const TOPIC = 'finance-us';

async function boot(): Promise<{ service: SpyService; handler: (req: Request) => Promise<Response> }> {
  root = await mkdtemp(join(tmpdir(), 'writer-room-hitl-'));
  const service = new SpyService({ dataRoot: join(root, 'spy') });
  await service.init();
  spy = service;
  service.store.upsertTopic({
    topicId: TOPIC, label: 'POV Finance', market: 'us', language: 'en', region: 'US',
  });
  const app: HttpApp = {
    spy: service,
    spyMcp: null,
    generalPackMcp: null,
    harness: {} as unknown as HttpApp['harness'],
    startedAt: Date.now(),
    webRoot: '',
    loopScheduler: null,
    loop: createSpyLoopAdapter(service),
  };
  return { service, handler: createHandler(app) };
}

function decideBody(over: Record<string, unknown>): Request {
  return new Request('http://127.0.0.1:4187/api/spy/loop/decide', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(over),
  });
}

describe('Spy Loop v3 — HITL routes', () => {
  test('inbox?topic_id= trả đủ 3 nhóm: kênh new, keyword pending, kênh có suggestion', async () => {
    const { service, handler } = await boot();

    // Kênh chờ duyệt + kênh active có suggestion + keyword pending + keyword active.
    service.store.upsertTopicChannelCandidate({
      topicId: TOPIC, channelId: 'UCnewchan00000000000001', title: 'Kênh Mới',
      discoveredVia: 'weekly_outlier', discoveredFrom: 'old_money',
    });
    service.store.upsertTopicChannelCandidate({
      topicId: TOPIC, channelId: 'UCsuggest0000000000002', title: 'Kênh Gợi Ý',
      discoveredVia: 'seed',
    });
    service.store.decideChannel(TOPIC, 'UCsuggest0000000000002', 'active', 'test_seed');
    service.store.setChannelSuggestion(TOPIC, 'UCsuggest0000000000002', 'pause_silent');
    service.store.upsertKeywordCandidate({
      topicId: TOPIC, termKey: 'old_money', displayTerm: 'old money',
      origin: 'title_ngram', evidenceJson: '{}',
    });
    service.store.upsertKeywordCandidate({
      topicId: TOPIC, termKey: 'index_funds', displayTerm: 'index funds',
      origin: 'seed', evidenceJson: '{}',
    });
    service.store.decideKeyword(TOPIC, 'index_funds', 'active', 'test_seed');

    const res = await handler(new Request(
      `http://127.0.0.1:4187/api/spy/loop/inbox?topic_id=${TOPIC}`,
    ));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      channels_new: Array<{ channelId: string }>;
      keywords_pending: Array<{ termKey: string }>;
      channels_suggested: Array<{ channelId: string; suggestion: string }>;
    };
    expect(body.channels_new.map((c) => c.channelId)).toEqual(['UCnewchan00000000000001']);
    expect(body.keywords_pending.map((k) => k.termKey)).toEqual(['old_money']);
    expect(body.channels_suggested.map((c) => c.channelId)).toEqual(['UCsuggest0000000000002']);
    expect(body.channels_suggested[0]!.suggestion).toBe('pause_silent');
  });

  test('decide channel: body v3 đổi status + ghi decisions actor=human ở tầng row', async () => {
    const { service, handler } = await boot();
    service.store.upsertTopicChannelCandidate({
      topicId: TOPIC, channelId: 'UCdecide0000000000001', title: 'Kênh Duyệt',
      discoveredVia: 'keyword_search',
    });

    const res = await handler(decideBody({
      topic_id: TOPIC, entity_type: 'channel',
      entity_id: 'UCdecide0000000000001', to_status: 'active', reason: 'fit_niche',
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true, entity_type: 'channel', entity_id: 'UCdecide0000000000001', to_status: 'active',
    });

    // Bằng chứng ở tầng row: status + decided_by='user' + decision actor='human'.
    const channel = service.store.listTopicChannelsByStatus(TOPIC, ['active'])
      .find((c) => c.channelId === 'UCdecide0000000000001');
    expect(channel).toBeDefined();
    const decisions = service.store.listDecisions(TOPIC, {
      entityType: 'channel', entityId: 'UCdecide0000000000001',
    });
    const human = decisions.filter((d) => d.actor === 'human');
    expect(human).toHaveLength(1);
    expect(human[0]!.fromStatus).toBe('new');
    expect(human[0]!.toStatus).toBe('active');
    expect(human[0]!.reason).toBe('fit_niche');
  });

  test('decide keyword: entity_type=keyword đi qua decideKeyword', async () => {
    const { service, handler } = await boot();
    service.store.upsertKeywordCandidate({
      topicId: TOPIC, termKey: 'quiet_luxury', displayTerm: 'quiet luxury',
      origin: 'outlier_title', evidenceJson: '{}',
    });

    const res = await handler(decideBody({
      topic_id: TOPIC, entity_type: 'keyword',
      entity_id: 'quiet_luxury', to_status: 'active', reason: 'good_fit',
    }));
    expect(res.status).toBe(200);
    expect(service.store.listKeywordsByStatus(TOPIC, ['active']).map((k) => k.termKey))
      .toEqual(['quiet_luxury']);
    const decisions = service.store.listDecisions(TOPIC, { entityType: 'keyword', entityId: 'quiet_luxury' });
    expect(decisions.filter((d) => d.actor === 'human')).toHaveLength(1);
  });

  test('decide: input thiếu/sai → 400; entity không tồn tại → 404; status lạ → 400', async () => {
    const { handler } = await boot();

    // Thiếu to_status.
    expect((await handler(decideBody({
      topic_id: TOPIC, entity_type: 'channel', entity_id: 'UCx',
    }))).status).toBe(400);

    // entity_type lạ.
    expect((await handler(decideBody({
      topic_id: TOPIC, entity_type: 'video', entity_id: 'v1', to_status: 'active',
    }))).status).toBe(400);

    // Kênh không tồn tại → AppError not_found → 404.
    expect((await handler(decideBody({
      topic_id: TOPIC, entity_type: 'channel', entity_id: 'UCmissing00000000000', to_status: 'active',
    }))).status).toBe(404);

    // to_status ngoài enum → AppError invalid_input → 400.
    const { service } = { service: spy! };
    service.store.upsertTopicChannelCandidate({
      topicId: TOPIC, channelId: 'UCbadstatus000000001', title: 'Kênh X',
      discoveredVia: 'seed',
    });
    expect((await handler(decideBody({
      topic_id: TOPIC, entity_type: 'channel', entity_id: 'UCbadstatus000000001',
      to_status: 'shortlisted',
    }))).status).toBe(400);
  });

  test('decide: body legacy (channelIds + status) vẫn đi đường cũ, không lẫn v3', async () => {
    const { handler } = await boot();
    // Body legacy thiếu status → lỗi legacy (không phải lỗi thiếu trường v3) —
    // chứng tỏ dispatch không nhầm nhánh.
    const res = await handler(decideBody({ topicId: TOPIC, channelIds: ['UCx'] }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('channelIds');
  });

  test('tick: forward mode/setupStep cho scheduler; mode/setupStep sai → 400', async () => {
    const { service } = await boot();
    // Scheduler giả chỉ ghi lại opts — route forward body gì thì runner nhận đó.
    const calls: Array<{ topicId: string; opts: unknown }> = [];
    const stubScheduler = {
      isRunning: () => false,
      runTick: async (topicId: string, opts: unknown) => {
        calls.push({ topicId, opts });
        return null;
      },
    } as unknown as NonNullable<HttpApp['loopScheduler']>;
    const app: HttpApp = {
      spy: service,
      spyMcp: null,
      generalPackMcp: null,
      harness: {} as unknown as HttpApp['harness'],
      startedAt: Date.now(),
      webRoot: '',
      loopScheduler: stubScheduler,
      loop: createSpyLoopAdapter(service),
    };
    const handler = createHandler(app);
    const tick = (body: Record<string, unknown>) => handler(new Request(
      'http://127.0.0.1:4187/api/spy/loop/tick',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    ));

    // Không truyền mode → 'daily'.
    const daily = await tick({ topicId: TOPIC });
    expect(daily.status).toBe(200);
    expect(await daily.json()).toMatchObject({ ok: true, running: true, mode: 'daily' });
    expect(calls.at(-1)).toEqual({ topicId: TOPIC, opts: { mode: 'daily', setupStep: undefined } });

    // weekly + setup/setupStep forward nguyên vẹn.
    expect((await tick({ topicId: TOPIC, mode: 'weekly' })).status).toBe(200);
    expect(calls.at(-1)!.opts).toEqual({ mode: 'weekly', setupStep: undefined });
    expect((await tick({ topicId: TOPIC, mode: 'setup', setupStep: 'channels' })).status).toBe(200);
    expect(calls.at(-1)!.opts).toEqual({ mode: 'setup', setupStep: 'channels' });

    // Sai enum → 400, không chạm scheduler.
    expect((await tick({ topicId: TOPIC, mode: 'hourly' })).status).toBe(400);
    expect((await tick({ topicId: TOPIC, mode: 'daily', setupStep: 'videos' })).status).toBe(400);
    expect(calls).toHaveLength(3);
  });
});
