import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SpyService } from '@writer-room/spy';
import type { HttpApp } from '../../src/http.ts';
import { createHandler } from '../../src/http.ts';

const UC = `UC${'b'.repeat(22)}`;
const VIDEO = 'abc123def45';
const roots: Array<{ root: string; spy: SpyService }> = [];

afterEach(async () => {
  for (const entry of roots.splice(0)) {
    entry.spy.store.close();
    await rm(entry.root, { recursive: true, force: true });
  }
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'daemon-spy-c1-route-'));
  const spy = new SpyService({ dataRoot: join(root, 'spy') });
  await spy.init();
  spy.store.upsertChannel({
    channelId: 'youtube:channel:/@route', youtubeUcId: UC, handle: '@route', title: 'Route Channel',
    subscriberCount: null, videoCount: null, totalViewCount: null, fetchedAt: '2026-08-30T00:00:00Z',
  });
  roots.push({ root, spy });
  const app: HttpApp = {
    spy, spyMcp: null, generalPackMcp: null, harness: {} as HttpApp['harness'], startedAt: Date.now(),
    webRoot: '', loopScheduler: null, loop: null,
  };
  return { handler: createHandler(app), spy };
}

describe('Spy C1 daemon HTTP routes', () => {
  test('supports exact star and local watchlist routes without creating operations', async () => {
    const { handler, spy } = await setup();
    const star = await handler(new Request(`http://127.0.0.1/api/spy/channels/${UC}/star`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: 'research' }),
    }));
    expect(star.status).toBe(200);
    expect(await star.json()).toMatchObject({ youtubeUcId: UC, starred: true, starredAt: expect.any(String) });

    const saved = await handler(new Request('http://127.0.0.1/api/spy/watchlists/local-desktop/channels?segment=saved'));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      channels: [{ youtubeUcId: UC, starred: true, watchStatus: null, note: 'research' }], nextCursor: null,
    });

    const follow = await handler(new Request(`http://127.0.0.1/api/spy/watchlists/local-desktop/competitors/${UC}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cadence: 'daily' }),
    }));
    expect(follow.status).toBe(200);
    expect(await follow.json()).toMatchObject({
      watchlistId: 'local-desktop', competitorChannelId: UC, watchStatus: 'followed', cadence: 'daily',
      lastObservedAt: null, nextDueAt: null,
    });

    const pause = await handler(new Request(`http://127.0.0.1/api/spy/watchlists/local-desktop/competitors/${UC}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ watchStatus: 'paused' }),
    }));
    expect(pause.status).toBe(200);
    expect(await pause.json()).toMatchObject({ watchStatus: 'paused', cadence: 'daily' });

    const followed = await handler(new Request('http://127.0.0.1/api/spy/watchlists/local-desktop/channels?segment=followed'));
    expect(await followed.json()).toMatchObject({ channels: [{ youtubeUcId: UC, starred: true, watchStatus: 'paused' }] });

    const vph = await handler(new Request(`http://127.0.0.1/api/spy/watchlists/local-desktop/competitors/${UC}/vph`));
    expect(vph.status).toBe(200);
    expect(await vph.json()).toMatchObject({
      youtubeUcId: UC, definitionVersion: 'vph/v1', segments: [], comparableCount: 0,
      timezone: 'Asia/Ho_Chi_Minh',
      provenance: { visibility: 'public', providerUsed: 'ytdlp', dataApiUsed: false },
      coverage: { rawPointCount: 0, latestRunStatus: null, truncated: false },
    });

    const oneHour = await handler(new Request(`http://127.0.0.1/api/spy/watchlists/local-desktop/competitors/${UC}/vph?window=1h&includeNonComparable=false`));
    expect(oneHour.status).toBe(200);
    expect(await oneHour.json()).toMatchObject({ requestedWindow: '1h', vphSegments: [], aggregations: { comparableCount: 0 } });

    const invalidWindow = await handler(new Request(`http://127.0.0.1/api/spy/watchlists/local-desktop/competitors/${UC}/vph?window=12h`));
    expect(invalidWindow.status).toBe(422);
    expect(await invalidWindow.json()).toMatchObject({ error: expect.stringContaining('invalid_window') });

    const obsoleteVphRoute = await handler(new Request(`http://127.0.0.1/api/spy/channels/${UC}/vph`));
    expect(obsoleteVphRoute.status).toBe(404);

    const startRun = spy.store.createOrGetPublicObservationRun({
      watchlistId: 'local-desktop', competitorChannelId: UC, planKind: 'daily', planVersion: 'route', localDate: '2026-08-30', playlistLimit: 1,
    }).run;
    const endRun = spy.store.createOrGetPublicObservationRun({
      watchlistId: 'local-desktop', competitorChannelId: UC, planKind: 'daily', planVersion: 'route', localDate: '2026-08-31', playlistLimit: 1,
    }).run;
    const basePoint = {
      sourceVideoId: VIDEO, youtubeUcId: UC, likeCount: null, commentCount: null, durationSec: 120, publishedAt: '2026-08-29T00:00:00.000Z', title: 'Measured',
      availability: 'present' as const, viewQuality: 'known' as const, providerUsed: 'ytdlp' as const, inspectUsed: true,
    };
    spy.store.insertPublicVideoStatPoint({ ...basePoint, observationRunId: startRun.id, sampledAt: '2026-08-30T00:00:00.000Z', viewCount: 100 });
    spy.store.insertPublicVideoStatPoint({ ...basePoint, observationRunId: endRun.id, sampledAt: '2026-08-31T00:00:00.000Z', viewCount: 1_300 });
    const drilldown = await handler(new Request(`http://127.0.0.1/api/spy/videos/${VIDEO}/vph`));
    expect(drilldown.status).toBe(200);
    expect(await drilldown.json()).toMatchObject({ sourceVideoId: VIDEO, rawPoints: [{ viewCount: 100 }, { viewCount: 1_300 }], vphSegments: [{ value: 50 }] });

    const operationsDb = new Database(spy.store.databasePath, { readonly: true });
    expect(Number((operationsDb.prepare('SELECT COUNT(*) AS n FROM operations').get() as { n: number }).n)).toBe(0);
    operationsDb.close();

    const unstar = await handler(new Request(`http://127.0.0.1/api/spy/channels/${UC}/star`, { method: 'DELETE' }));
    expect(await unstar.json()).toEqual({ youtubeUcId: UC, starred: false });
    const unfollow = await handler(new Request(`http://127.0.0.1/api/spy/watchlists/local-desktop/competitors/${UC}`, { method: 'DELETE' }));
    expect(await unfollow.json()).toMatchObject({ removed: true, competitorChannelId: UC });
  });

  test('maps invalid and unresolved channel identities clearly', async () => {
    const { handler } = await setup();
    const invalid = await handler(new Request('http://127.0.0.1/api/spy/channels/not-a-uc/star', { method: 'PUT' }));
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({ error: expect.stringContaining('channel_unresolved_or_invalid') });

    const unresolved = `UC${'c'.repeat(22)}`;
    const unknown = await handler(new Request(`http://127.0.0.1/api/spy/channels/${unresolved}/star`, { method: 'PUT' }));
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: expect.stringContaining('channel_unknown') });

    const vphWithoutFollow = await handler(new Request(
      `http://127.0.0.1/api/spy/watchlists/local-desktop/competitors/${UC}/vph`,
    ));
    expect(vphWithoutFollow.status).toBe(404);
    expect(await vphWithoutFollow.json()).toMatchObject({ error: expect.stringContaining('channel_not_followed') });
  });

  test('does not start a manual observation while the separate channel-watch kill switch is disabled', async () => {
    const { handler } = await setup();
    const follow = await handler(new Request(`http://127.0.0.1/api/spy/watchlists/local-desktop/competitors/${UC}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cadence: 'daily' }),
    }));
    expect(follow.status).toBe(200);

    const observe = await handler(new Request(`http://127.0.0.1/api/spy/watchlists/local-desktop/competitors/${UC}/observe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    }));
    expect(observe.status).toBe(409);
    expect(await observe.json()).toMatchObject({ error: expect.stringContaining('channel_watch_disabled') });
  });
});
