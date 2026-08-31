import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpyService } from '@writer-room/spy';
import type { YoutubePort } from '@writer-room/spy';
import type { RecommendationCapturePort } from '@writer-room/spy';
import type { GeminiFlashAnalysisPort } from '@writer-room/spy';
import type { HttpApp } from '../../src/http.ts';
import { createHandler } from '../../src/http.ts';

const roots: Array<{ root: string; spy: SpyService }> = [];

afterEach(async () => {
  for (const { root, spy } of roots.splice(0)) {
    spy.store.close();
    await rm(root, { recursive: true, force: true });
  }
});

const youtube = {
  async inspectVideo(canonicalUrl: string) {
    return { sourceVideoId: 'abc123def45', canonicalUrl, title: 'Seed', channelTitle: 'Kênh', channelId: 'UCseed', viewCount: 1, durationSec: 60, publishedAt: null, thumbnailUrl: null };
  },
  async listChannel() { return []; },
  async fetchTranscript() { return { status: 'missing' as const, language: null, source: 'unknown' as const, segments: [] }; },
  async streamUrl() { return 'https://stream.test'; },
  async thumbnail() { return { bytes: new Uint8Array(), mimeType: 'image/jpeg' }; },
} as YoutubePort;

const recommendations: RecommendationCapturePort = {
  async captureDirect(input) {
    return {
      method: 'fixture_direct_suggestions', adapterVersion: 'test', observedAt: '2026-08-26T00:00:00.000Z', observedSeedUrl: input.seed.canonicalUrl,
      suggestions: [{ observedUrl: 'https://youtu.be/zyx987wvu65', observedPosition: 1, title: 'Target' }],
    };
  },
};

const gemini: GeminiFlashAnalysisPort = {
  model: 'fixture',
  async analyze() { return { labels: [], keywordCandidates: [], claims: [] }; },
};

async function setup(options: { recommendationCapture?: RecommendationCapturePort | null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'daemon-p0-route-'));
  const recommendationCapture = options.recommendationCapture === undefined ? recommendations : options.recommendationCapture;
  const spy = new SpyService({
    dataRoot: join(root, 'spy'), youtube,
    ...(recommendationCapture ? { recommendationCapture } : {}),
    geminiFlash: gemini,
  });
  await spy.init();
  spy.store.upsertTopic({ topicId: 'finance-vi', label: 'Tài chính', market: 'VN', language: 'vi' });
  roots.push({ root, spy });
  const app: HttpApp = {
    spy, spyMcp: null, generalPackMcp: null, harness: {} as HttpApp['harness'], startedAt: Date.now(), webRoot: '', loopScheduler: null, loop: null,
  };
  return { handler: createHandler(app), spy };
}

describe('Spy P0 Corpus Intelligence HTTP routes', () => {
  test('draft import is visible, confirm is explicit, and C3 never leaks into legacy loop tables', async () => {
    const { handler, spy } = await setup();
    const create = await handler(new Request('http://127.0.0.1/api/spy/p0/corpus-imports', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topicId: 'finance-vi', url: 'https://www.youtube.com/watch?v=abc123def45', idempotencyKey: 'import-1' }),
    }));
    expect(create.status).toBe(201);
    const draft = await create.json() as { batch: { id: string; status: string } };
    expect(draft.batch.status).toBe('draft');

    const before = await handler(new Request('http://127.0.0.1/api/spy/p0/overview?topic=finance-vi'));
    expect((await before.json() as { memberships: unknown[] }).memberships).toHaveLength(0);

    const confirmed = await handler(new Request(`http://127.0.0.1/api/spy/p0/corpus-imports/${draft.batch.id}/confirm`, { method: 'POST' }));
    expect(confirmed.status).toBe(200);
    const confirmedPayload = await confirmed.json() as { memberships: Array<{ id: string }> };
    const capture = await handler(new Request('http://127.0.0.1/api/spy/p0/recommendation-captures', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topicId: 'finance-vi', seedMembershipId: confirmedPayload.memberships[0]!.id, idempotencyKey: 'capture-1' }),
    }));
    expect(capture.status).toBe(201);
    const captured = await capture.json() as { batch: { observations: unknown[] } };
    expect(captured.batch.observations).toHaveLength(1);

    const overview = await handler(new Request('http://127.0.0.1/api/spy/p0/overview?topic=finance-vi'));
    const payload = await overview.json() as { recommendationBatches: Array<{ observations: unknown[] }> };
    expect(payload.recommendationBatches[0]!.observations).toHaveLength(1);
    expect(spy.store.listCandidates()).toHaveLength(0);
    expect(spy.store.listTopicChannels('finance-vi')).toHaveLength(0);
    expect(spy.store.listTopicChannelSources('finance-vi')).toHaveLength(0);

    const serialized = JSON.stringify(payload);
    for (const forbidden of ['ownerSubject', 'idempotencyKey', 'requestDigest', 'relativePath', 'captureArtifact', 'captureDigest', 'artifactDigest', 'rawResponseArtifact', 'cookie']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test('route rejects oversized/malformed C3 input before provider invocation and returns a typed unavailable port error', async () => {
    let calls = 0;
    const trace: RecommendationCapturePort = { async captureDirect() { calls += 1; throw new Error('provider must not run'); } };
    const { handler } = await setup({ recommendationCapture: trace });
    const huge = await handler(new Request('http://127.0.0.1/api/spy/p0/corpus-imports', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'content-length': '999999' }, body: '{}',
    }));
    expect(huge.status).toBe(413);

    const invalid = await handler(new Request('http://127.0.0.1/api/spy/p0/recommendation-captures', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topicId: 'finance-vi', seedMembershipId: 'missing', idempotencyKey: 'bad-type', depth: '1' }),
    }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: expect.stringContaining('depth') });
    expect(calls).toBe(0);

    const unavailable = await setup({ recommendationCapture: null });
    const draft = await unavailable.handler(new Request('http://127.0.0.1/api/spy/p0/corpus-imports', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topicId: 'finance-vi', url: 'https://www.youtube.com/watch?v=abc123def45', idempotencyKey: 'unavailable-import' }),
    }));
    const imported = await draft.json() as { batch: { id: string } };
    const confirmed = await unavailable.handler(new Request(`http://127.0.0.1/api/spy/p0/corpus-imports/${imported.batch.id}/confirm`, { method: 'POST' }));
    const membership = (await confirmed.json() as { memberships: Array<{ id: string }> }).memberships[0]!;
    const missing = await unavailable.handler(new Request('http://127.0.0.1/api/spy/p0/recommendation-captures', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topicId: 'finance-vi', seedMembershipId: membership.id, idempotencyKey: 'unavailable-c3' }),
    }));
    expect(missing.status).toBe(503);
    expect(await missing.json()).toMatchObject({ error: expect.stringContaining('chưa được cấu hình') });
  });
});
