import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SpyService } from '../src/index.ts';
import type { YoutubePort, YoutubeVideoObservationInfo } from '../src/adapters/ytdlp.ts';
import { deriveVphSegment } from '../src/channel-intelligence/observations.ts';
import type { PublicVideoStatPoint } from '../src/channel-intelligence/types.ts';

const UC = `UC${'v'.repeat(22)}`;
const VIDEO = 'abc123def45';
let root = '';
let spy: SpyService | null = null;

function fixtureObservation(viewCount: number | null): YoutubeVideoObservationInfo {
  return {
    sourceVideoId: VIDEO, canonicalUrl: `https://www.youtube.com/watch?v=${VIDEO}`,
    title: 'Measured video', channelTitle: 'Measured channel', channelId: UC,
    viewCount, likeCount: null, commentCount: null, durationSec: 120,
    publishedAt: '2026-08-30T00:00:00.000Z',
  };
}

function fakeYoutube(ref: { views: number | null; listCalls: number; inspectCalls: number; failInspect?: boolean }): YoutubePort {
  return {
    inspectVideo: async () => { throw new Error('legacy inspect must not be called'); },
    listChannel: async () => { throw new Error('legacy list must not be called'); },
    fetchTranscript: async () => ({ status: 'missing', language: null, source: 'unknown', segments: [] }),
    streamUrl: async () => { throw new Error('unused'); },
    thumbnail: async () => ({ bytes: new Uint8Array(), mimeType: 'image/jpeg' }),
    listChannelObservation: async () => {
      ref.listCalls += 1;
      return [fixtureObservation(null)];
    },
    inspectVideoObservation: async () => {
      ref.inspectCalls += 1;
      if (ref.failInspect) throw new Error('provider unavailable');
      return fixtureObservation(ref.views);
    },
  };
}

function legacyOnlyYoutube(): YoutubePort {
  return {
    inspectVideo: async () => { throw new Error('unused'); },
    listChannel: async () => { throw new Error('unused'); },
    fetchTranscript: async () => ({ status: 'missing', language: null, source: 'unknown', segments: [] }),
    streamUrl: async () => { throw new Error('unused'); },
    thumbnail: async () => ({ bytes: new Uint8Array(), mimeType: 'image/jpeg' }),
  };
}

function knownPoint(sampledAt: string, viewCount: number): PublicVideoStatPoint {
  return {
    id: `${sampledAt}-${viewCount}`, observationRunId: 'run', sourceVideoId: VIDEO, youtubeUcId: UC,
    sampledAt, viewCount, likeCount: null, commentCount: null, durationSec: null,
    publishedAt: null, title: 'Measured video', availability: 'present', viewQuality: 'known',
    providerUsed: 'ytdlp', inspectUsed: true, createdAt: sampledAt,
  };
}

afterEach(async () => {
  spy?.store.close();
  spy = null;
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

describe('C3 public yt-dlp observation + VPH', () => {
  test('collects inspect-only nullable public points, never creates a Spy operation, and derives actual-window VPH', async () => {
    root = await mkdtemp(join(tmpdir(), 'spy-public-vph-'));
    const calls = { views: 300, listCalls: 0, inspectCalls: 0 };
    spy = new SpyService({ dataRoot: root, youtube: fakeYoutube(calls) });
    await spy.init();
    spy.store.upsertChannel({
      channelId: 'youtube:channel:/@measured', youtubeUcId: UC, handle: '@measured', title: 'Measured channel',
      subscriberCount: null, videoCount: null, totalViewCount: null, fetchedAt: '2026-08-30T00:00:00.000Z',
    });
    spy.followChannel(UC, { cadence: 'daily' });

    const first = await spy.observePublicChannel({
      youtubeUcId: UC, planKind: 'daily', localDate: '2026-08-30', now: new Date('2026-08-30T00:00:00.000Z'),
    });
    expect(first.run).toMatchObject({ providerUsed: 'ytdlp', status: 'completed', inspectAttempted: 1, inspectOk: 1 });
    calls.views = 1_500;
    const second = await spy.observePublicChannel({
      youtubeUcId: UC, planKind: 'daily', localDate: '2026-08-31', now: new Date('2026-08-31T00:00:00.000Z'),
    });
    expect(second.run.status).toBe('completed');
    const duplicate = await spy.observePublicChannel({
      youtubeUcId: UC, planKind: 'daily', localDate: '2026-08-31', now: new Date('2026-08-31T12:00:00.000Z'),
    });
    expect(duplicate.reused).toBe(true);
    expect(calls).toEqual({ views: 1_500, listCalls: 2, inspectCalls: 2 });
    const database = new Database(spy.store.databasePath, { readonly: true });
    expect(Number((database.prepare('SELECT COUNT(*) AS n FROM operations').get() as { n: number }).n)).toBe(0);
    database.close();

    const vph = spy.getPublicChannelVph(UC);
    expect(vph.comparableCount).toBe(1);
    expect(vph.segments[0]).toMatchObject({
      sourceVideoId: VIDEO, value: 50, actualElapsedHours: 24,
      method: 'deterministic', comparability: 'comparable_24h', definitionVersion: 'vph/v1',
    });
    expect(spy.listWatchlistChannels('local-desktop', 'followed').channels[0]).toMatchObject({
      lastObservationStatus: 'completed', lastObservationCompleteness: 'complete',
      comparableVph24hCount: 1, medianVph24h: null,
    });
  });

  test('settles a newly-created run unavailable when the yt-dlp observation capability is absent', async () => {
    root = await mkdtemp(join(tmpdir(), 'spy-public-vph-capability-'));
    spy = new SpyService({ dataRoot: root, youtube: legacyOnlyYoutube() });
    await spy.init();
    spy.store.upsertChannel({
      channelId: UC, youtubeUcId: UC, handle: '@known', title: 'Known',
      subscriberCount: null, videoCount: null, totalViewCount: null, fetchedAt: '2026-08-30T00:00:00.000Z',
    });
    spy.followChannel(UC);

    const first = await spy.observePublicChannel({
      youtubeUcId: UC, planKind: 'daily', localDate: '2026-08-30', now: new Date('2026-08-30T00:00:00.000Z'),
    });
    expect(first).toMatchObject({ reused: false, run: { status: 'unavailable', errorCode: 'capability_missing' } });

    const duplicate = await spy.observePublicChannel({
      youtubeUcId: UC, planKind: 'daily', localDate: '2026-08-30', now: new Date('2026-08-30T01:00:00.000Z'),
    });
    expect(duplicate).toMatchObject({ reused: true, run: { status: 'unavailable', errorCode: 'capability_missing' } });
  });

  test('uses actual elapsed time and applies the exact 24h comparability boundaries without rescaling', () => {
    const start = new Date('2026-08-30T00:00:00.000Z');
    const segmentAt = (hours: number) => deriveVphSegment([
      knownPoint(start.toISOString(), 300),
      knownPoint(new Date(start.getTime() + hours * 3_600_000).toISOString(), 300 + hours * 10),
    ]);

    expect(segmentAt(17)).toMatchObject({ value: 10, actualElapsedHours: 17, comparability: 'not_comparable_to_24h' });
    expect(segmentAt(18)).toMatchObject({ value: 10, actualElapsedHours: 18, comparability: 'comparable_24h' });
    expect(segmentAt(30)).toMatchObject({ value: 10, actualElapsedHours: 30, comparability: 'comparable_24h' });
    expect(segmentAt(31)).toMatchObject({ value: 10, actualElapsedHours: 31, comparability: 'stretched' });
  });

  test('does not bridge VPH across an error/private/missing observation point', async () => {
    root = await mkdtemp(join(tmpdir(), 'spy-public-vph-gap-'));
    const calls = { views: 100 as number | null, listCalls: 0, inspectCalls: 0, failInspect: false };
    spy = new SpyService({ dataRoot: root, youtube: fakeYoutube(calls) });
    await spy.init();
    spy.store.upsertChannel({
      channelId: UC, youtubeUcId: UC, handle: '@known', title: 'Known',
      subscriberCount: null, videoCount: null, totalViewCount: null, fetchedAt: '2026-08-30T00:00:00.000Z',
    });
    spy.followChannel(UC);
    await spy.observePublicChannel({ youtubeUcId: UC, planKind: 'daily', localDate: '2026-08-30', now: new Date('2026-08-30T00:00:00.000Z') });
    calls.failInspect = true;
    await spy.observePublicChannel({ youtubeUcId: UC, planKind: 'daily', localDate: '2026-08-31', now: new Date('2026-08-31T00:00:00.000Z') });
    calls.failInspect = false;
    calls.views = 500;
    await spy.observePublicChannel({ youtubeUcId: UC, planKind: 'daily', localDate: '2026-09-01', now: new Date('2026-09-01T00:00:00.000Z') });

    expect(spy.getPublicChannelVph(UC).segments[0]).toMatchObject({
      value: null, method: 'unavailable', comparability: 'unavailable', reason: expect.stringContaining('missing_measurement'),
    });
  });

  test('reads telemetry in sample-time order and exposes pagination rather than silently truncating video ids', async () => {
    root = await mkdtemp(join(tmpdir(), 'spy-public-vph-page-'));
    spy = new SpyService({ dataRoot: root, youtube: legacyOnlyYoutube() });
    await spy.init();
    const created = spy.store.createOrGetPublicObservationRun({
      watchlistId: 'local-desktop', competitorChannelId: UC, planKind: 'manual', planVersion: 'test', localDate: '2026-08-30', playlistLimit: 3,
    });
    for (const [sourceVideoId, sampledAt] of [
      ['zzz123def45', '2026-08-31T00:00:00.000Z'],
      ['aaa123def45', '2026-08-30T00:00:00.000Z'],
      ['mmm123def45', '2026-08-30T12:00:00.000Z'],
    ] as const) {
      spy.store.insertPublicVideoStatPoint({
        observationRunId: created.run.id, sourceVideoId, youtubeUcId: UC, sampledAt,
        viewCount: 1, likeCount: null, commentCount: null, durationSec: null, publishedAt: null, title: null,
        availability: 'present', viewQuality: 'known', providerUsed: 'ytdlp', inspectUsed: true,
      });
    }
    const page = spy.store.listPublicVideoStatPointsPage({ youtubeUcId: UC, limit: 2 });
    expect(page.points.map((point) => point.sampledAt)).toEqual(['2026-08-30T00:00:00.000Z', '2026-08-30T12:00:00.000Z']);
    expect(page).toMatchObject({ truncated: true, nextCursor: expect.any(String) });
  });

  test('uses the mathematical median for an even comparable VPH cohort', async () => {
    root = await mkdtemp(join(tmpdir(), 'spy-public-vph-median-'));
    spy = new SpyService({ dataRoot: root, youtube: legacyOnlyYoutube() });
    await spy.init();
    spy.store.upsertChannel({
      channelId: UC, youtubeUcId: UC, handle: '@known', title: 'Known',
      subscriberCount: null, videoCount: null, totalViewCount: null, fetchedAt: '2026-08-30T00:00:00.000Z',
    });
    spy.followChannel(UC);
    const startRun = spy.store.createOrGetPublicObservationRun({
      watchlistId: 'local-desktop', competitorChannelId: UC, planKind: 'daily', planVersion: 'median', localDate: '2026-08-30', playlistLimit: 6,
    }).run;
    const endRun = spy.store.createOrGetPublicObservationRun({
      watchlistId: 'local-desktop', competitorChannelId: UC, planKind: 'daily', planVersion: 'median', localDate: '2026-08-31', playlistLimit: 6,
    }).run;
    for (const value of [10, 20, 30, 40, 50, 60]) {
      const sourceVideoId = `vid${String(value).padStart(8, '0')}`;
      const common = {
        sourceVideoId, youtubeUcId: UC, likeCount: null, commentCount: null, durationSec: null, publishedAt: null, title: null,
        availability: 'present' as const, viewQuality: 'known' as const, providerUsed: 'ytdlp' as const, inspectUsed: true,
      };
      spy.store.insertPublicVideoStatPoint({ ...common, observationRunId: startRun.id, sampledAt: '2026-08-30T00:00:00.000Z', viewCount: 0 });
      spy.store.insertPublicVideoStatPoint({ ...common, observationRunId: endRun.id, sampledAt: '2026-08-31T00:00:00.000Z', viewCount: value * 24 });
    }
    expect(spy.getPublicChannelVph(UC).aggregations).toMatchObject({ comparableCount: 6, medianVph: 35 });
  });

  test('derives channel VPH before cursor/limit projection so a pair cannot split across pages', async () => {
    root = await mkdtemp(join(tmpdir(), 'spy-public-vph-projection-'));
    spy = new SpyService({ dataRoot: root, youtube: legacyOnlyYoutube() });
    await spy.init();
    spy.store.upsertChannel({
      channelId: UC, youtubeUcId: UC, handle: '@known', title: 'Known',
      subscriberCount: null, videoCount: null, totalViewCount: null, fetchedAt: '2026-08-30T00:00:00.000Z',
    });
    spy.followChannel(UC);
    const start = spy.store.createOrGetPublicObservationRun({
      watchlistId: 'local-desktop', competitorChannelId: UC, planKind: 'daily', planVersion: 'projection', localDate: '2026-08-30', playlistLimit: 2,
    }).run;
    const end = spy.store.createOrGetPublicObservationRun({
      watchlistId: 'local-desktop', competitorChannelId: UC, planKind: 'daily', planVersion: 'projection', localDate: '2026-08-31', playlistLimit: 2,
    }).run;
    const common = {
      sourceVideoId: VIDEO, youtubeUcId: UC, likeCount: null, commentCount: null, durationSec: null, publishedAt: null, title: null,
      availability: 'present' as const, viewQuality: 'known' as const, providerUsed: 'ytdlp' as const, inspectUsed: true,
    };
    spy.store.insertPublicVideoStatPoint({ ...common, observationRunId: start.id, sampledAt: '2026-08-30T00:00:00.000Z', viewCount: 100 });
    // Another video's middle timestamp forces a global time page boundary in
    // the old implementation; the VPH pair above/below must still survive.
    spy.store.insertPublicVideoStatPoint({ ...common, sourceVideoId: 'zzz123def45', observationRunId: start.id, sampledAt: '2026-08-30T12:00:00.000Z', viewCount: 1 });
    spy.store.insertPublicVideoStatPoint({ ...common, observationRunId: end.id, sampledAt: '2026-08-31T00:00:00.000Z', viewCount: 1_300 });

    const read = spy.getPublicChannelVph(UC, 'local-desktop', { limit: 1 });
    expect(read).toMatchObject({ coverage: { truncated: false, nextCursor: null }, aggregations: { comparableCount: 1, medianVph: null } });
    expect(read.vphSegments).toContainEqual(expect.objectContaining({ sourceVideoId: VIDEO, value: 50 }));
  });

  test('unknown view count remains unknown, not zero, and counter dips do not become a clamped VPH', async () => {
    root = await mkdtemp(join(tmpdir(), 'spy-public-vph-unknown-'));
    const calls = { views: null as number | null, listCalls: 0, inspectCalls: 0 };
    spy = new SpyService({ dataRoot: root, youtube: fakeYoutube(calls) });
    await spy.init();
    spy.store.upsertChannel({
      channelId: UC, youtubeUcId: UC, handle: '@known', title: 'Known',
      subscriberCount: null, videoCount: null, totalViewCount: null, fetchedAt: '2026-08-30T00:00:00.000Z',
    });
    spy.followChannel(UC);
    await spy.observePublicChannel({ youtubeUcId: UC, planKind: 'daily', localDate: '2026-08-30', now: new Date('2026-08-30T00:00:00.000Z') });
    const unknown = spy.store.listPublicVideoStatPoints(UC)[0]!;
    expect(unknown).toMatchObject({ viewCount: null, viewQuality: 'unknown', inspectUsed: true });
    calls.views = 100;
    await spy.observePublicChannel({ youtubeUcId: UC, planKind: 'daily', localDate: '2026-08-31', now: new Date('2026-08-31T00:00:00.000Z') });
    calls.views = 90;
    await spy.observePublicChannel({ youtubeUcId: UC, planKind: 'daily', localDate: '2026-09-01', now: new Date('2026-09-01T00:00:00.000Z') });
    expect(spy.getPublicChannelVph(UC).segments[0]).toMatchObject({
      value: null, method: 'unavailable', reason: expect.stringContaining('count_decreased'),
    });
  });
});
