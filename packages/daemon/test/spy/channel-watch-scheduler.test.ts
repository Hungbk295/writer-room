import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SpyService, type YoutubePort, type YoutubeVideoObservationInfo } from '@writer-room/spy';
import { ChannelWatchScheduler } from '../../src/spy/channel-watch-scheduler.ts';
import { channelWatchConfigSchema, saveChannelWatchConfig } from '../../src/spy/channel-watch-config.ts';

const UC = `UC${'s'.repeat(22)}`;
let root = '';
let spy: SpyService | null = null;

function observation(views: number): YoutubeVideoObservationInfo {
  return {
    sourceVideoId: 'abc123def45', canonicalUrl: 'https://www.youtube.com/watch?v=abc123def45',
    title: 'Sample', channelTitle: 'Watch target', channelId: UC,
    viewCount: views, likeCount: null, commentCount: null, durationSec: 60, publishedAt: null,
  };
}

afterEach(async () => {
  spy?.store.close();
  spy = null;
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

describe('ChannelWatchScheduler', () => {
  test('kill switch makes zero yt-dlp calls; enabled schedule observes once and is idempotent', async () => {
    root = await mkdtemp(join(tmpdir(), 'daemon-channel-watch-'));
    const calls = { list: 0, inspect: 0 };
    const youtube: YoutubePort = {
      inspectVideo: async () => { throw new Error('legacy inspect must not run'); },
      listChannel: async () => { throw new Error('legacy list must not run'); },
      fetchTranscript: async () => ({ status: 'missing', language: null, source: 'unknown', segments: [] }),
      streamUrl: async () => { throw new Error('unused'); },
      thumbnail: async () => ({ bytes: new Uint8Array(), mimeType: 'image/jpeg' }),
      listChannelObservation: async () => { calls.list += 1; return [observation(200)]; },
      inspectVideoObservation: async () => { calls.inspect += 1; return observation(200); },
    };
    spy = new SpyService({ dataRoot: join(root, 'spy'), youtube });
    await spy.init();
    spy.store.upsertChannel({
      channelId: UC, youtubeUcId: UC, handle: '@watch-target', title: 'Watch target',
      subscriberCount: null, videoCount: null, totalViewCount: null, fetchedAt: '2026-08-30T00:00:00.000Z',
    });
    spy.followChannel(UC);
    const now = () => new Date('2026-09-01T09:00:00.000Z'); // 16:00 ICT
    const scheduler = new ChannelWatchScheduler(spy, root, now);
    expect(await scheduler.tick()).toBe(0);
    expect(calls).toEqual({ list: 0, inspect: 0 });

    await saveChannelWatchConfig(root, { enabled: true, dailyHourLocal: '15:30', timezone: 'Asia/Ho_Chi_Minh' });
    expect(await scheduler.tick()).toBe(1);
    expect(calls).toEqual({ list: 1, inspect: 1 });
    expect(await scheduler.tick()).toBe(0);
    expect(calls).toEqual({ list: 1, inspect: 1 });
    scheduler.dispose();
  });

  test('validates timezone and enforces a per-relation wall-clock budget', async () => {
    expect(channelWatchConfigSchema.safeParse({ timezone: 'not/a-real-timezone' }).success).toBe(false);
    root = await mkdtemp(join(tmpdir(), 'daemon-channel-watch-budget-'));
    const youtube: YoutubePort = {
      inspectVideo: async () => { throw new Error('legacy inspect must not run'); },
      listChannel: async () => { throw new Error('legacy list must not run'); },
      fetchTranscript: async () => ({ status: 'missing', language: null, source: 'unknown', segments: [] }),
      streamUrl: async () => { throw new Error('unused'); },
      thumbnail: async () => ({ bytes: new Uint8Array(), mimeType: 'image/jpeg' }),
      listChannelObservation: async () => [observation(200)],
      inspectVideoObservation: async (_url, signal) => new Promise<YoutubeVideoObservationInfo>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted for test')), { once: true });
      }),
    };
    spy = new SpyService({ dataRoot: join(root, 'spy'), youtube });
    await spy.init();
    spy.store.upsertChannel({
      channelId: UC, youtubeUcId: UC, handle: '@watch-target', title: 'Watch target',
      subscriberCount: null, videoCount: null, totalViewCount: null, fetchedAt: '2026-08-30T00:00:00.000Z',
    });
    spy.followChannel(UC);
    await saveChannelWatchConfig(root, {
      enabled: true, dailyHourLocal: '15:30', timezone: 'Asia/Ho_Chi_Minh', perRelationWallClockMs: 1_000,
    });
    const scheduler = new ChannelWatchScheduler(spy, root, () => new Date('2026-09-01T09:00:00.000Z'));
    const started = Date.now();
    expect(await scheduler.tick()).toBe(1);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(spy.store.listPublicObservationRuns('local-desktop', UC, 1)[0]).toMatchObject({ status: 'unavailable', completeness: 'unavailable' });
    scheduler.dispose();
  });
});
