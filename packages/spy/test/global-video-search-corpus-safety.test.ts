import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SpyService, type VideoSnapshot, type YouTubeDataApiPort, type YoutubePort } from '../src/index.ts';

/**
 * Regression guard for the real incident behind the spy_global_video_search
 * fix: corpusChannelStats()/searchCorpusVideos() cluster every video into a
 * channel by "which spy_run produced its newest video_snapshots row"
 * (ROW_NUMBER PARTITION BY source_video_id ORDER BY created_at DESC, joined
 * to spy_runs.source_identity). Writing a search hit into video_snapshots —
 * even tagged as a search kind — creates a brand-new spy_run and becomes
 * that video's "newest" row, silently pulling it out of its channel's
 * cluster. This is exactly how Hidden Yield's channel average got reported
 * as 3,668 instead of correctly including its 380,079-view video: a lone
 * spy_video_start run on an already-scanned video reassigned it.
 *
 * spy_global_video_search must never touch video_snapshots/spy_runs, so a
 * channel's corpus stats (avg/max views, video count) must be
 * byte-identical before and after a global search that returns one of that
 * channel's videos.
 */

const roots: string[] = [];
const services: SpyService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) service.store.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Global search never uses yt-dlp when a Data API adapter is configured; only present to satisfy SpyService's constructor. */
function noopYoutube(): YoutubePort {
  return { async searchVideos(_query: string, _limit: number) { return []; } } as unknown as YoutubePort;
}

function channelSnapshot(spyRunId: string, sourceVideoId: string, viewCount: number, rank: number): VideoSnapshot {
  return {
    id: randomUUID(),
    spyRunId,
    sourceVideoId,
    canonicalUrl: `https://www.youtube.com/watch?v=${sourceVideoId}`,
    title: `Video ${sourceVideoId}`,
    channelTitle: 'Hidden Yield',
    rank,
    viewCount,
    likeCount: 10,
    commentCount: 2,
    durationSec: 300,
    publishedAt: '2026-01-01T00:00:00.000Z',
    tags: [],
    transcriptStatus: 'ok',
    transcriptSource: 'manual',
    frameStatus: 'ok',
    thumbnail: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
  };
}

describe('spy_global_video_search corpus safety', () => {
  test("a search that returns an already-scanned channel video does not change that channel's corpus stats", async () => {
    const outlierVideoId = 'hy_outlier_001';
    const normalVideoId = 'hy_normal_002';

    const dataApi: YouTubeDataApiPort = {
      async search() {
        return {
          hits: [{
            kind: 'video',
            videoId: outlierVideoId,
            channelId: 'UChiddenyield',
            title: 'Video hy_outlier_001 (từ search)',
            description: null,
            channelTitle: 'Hidden Yield',
            publishedAt: '2026-02-01T00:00:00Z',
            thumbnailUrl: null,
          }],
          nextPageToken: null,
        };
      },
      async fetchVideoStatistics(videoIds) {
        return new Map(videoIds.map((id) => [id, {
          videoId: id,
          likeCount: 1,
          commentCount: 1,
          // Deliberately different from the channel-scan view count, to prove
          // this write cannot leak into video_snapshots/corpus stats at all.
          viewCount: 999,
          publishedAt: '2026-02-01T00:00:00Z',
          publishedAtPrecision: 'second' as const,
          durationSec: 300,
          tags: [],
          title: 'Video hy_outlier_001 (từ search)',
          channelId: 'UChiddenyield',
          channelTitle: 'Hidden Yield',
          thumbnailUrl: null,
          defaultAudioLanguage: 'vi',
          defaultLanguage: 'vi',
        }]));
      },
      async fetchChannelStatistics() { return new Map(); },
    };
    const youtube = noopYoutube();

    const root = await mkdtemp(join(tmpdir(), 'wr-global-search-corpus-safety-'));
    roots.push(root);
    const service = new SpyService({ dataRoot: join(root, 'spy'), youtube, dataApi });
    services.push(service);
    await service.init();

    // 1. Seed a channel scan exactly like AcquisitionService would: one
    //    spy_run (kind: 'channel') with two video_snapshots.
    const op = service.store.createOrGetOperation({
      kind: 'acquire_channel',
      ownerSubject: 'test',
      idempotencyKey: 'seed-hidden-yield',
      request: { url: 'https://www.youtube.com/channel/UChiddenyield' },
    });
    const channelRun = service.store.createSpyRun({
      operationId: op.operation.id,
      kind: 'channel',
      canonicalSource: 'https://www.youtube.com/channel/UChiddenyield',
      sourceIdentity: 'youtube:channel:UChiddenyield',
      config: {},
    });
    service.store.insertVideoSnapshot(channelSnapshot(channelRun.id, outlierVideoId, 380_079, 1));
    service.store.insertVideoSnapshot(channelSnapshot(channelRun.id, normalVideoId, 3_668, 2));
    // corpusChannelStats() groups by video_snapshots.channel_id (v10) — a
    // real channel scan always resolves and attaches this via
    // setVideoSnapshotsChannelId(), so the fixture must too.
    const channelRecord = service.store.upsertChannel({
      channelId: 'youtube:channel:UChiddenyield', youtubeUcId: 'UChiddenyield'.padEnd(24, '0'),
      title: 'Hidden Yield', subscriberCount: null, videoCount: null, totalViewCount: null,
      fetchedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    });
    service.store.setVideoSnapshotsChannelId(channelRun.id, channelRecord.id);

    const before = service.store.corpusChannelStats().find((row) => row.channelKey === 'youtube:channel:UChiddenyield');
    expect(before).toBeDefined();
    expect(before!.videoCount).toBe(2);
    expect(before!.maxViews).toBe(380_079);
    expect(before!.avgViews).toBeCloseTo((380_079 + 3_668) / 2, 3);

    // 2. Now run a global keyword search that happens to surface the same
    //    outlier video (this is the operation under test).
    const result = await service.globalVideoSearch({ query: 'hidden yield outlier' });
    expect(result.videos).toEqual([expect.objectContaining({ videoId: outlierVideoId, viewCount: 999 })]);

    // 3. video_snapshots / spy_runs for the channel must be untouched...
    expect(service.store.listVideoSnapshots(channelRun.id)).toHaveLength(2);
    expect(service.store.listVideoSnapshots(channelRun.id).map((row) => row.viewCount).sort()).toEqual([3_668, 380_079]);

    // 4. ...and corpus stats for the channel must be byte-identical.
    const after = service.store.corpusChannelStats().find((row) => row.channelKey === 'youtube:channel:UChiddenyield');
    expect(after).toEqual(before);

    // 5. The search result was still persisted — just not into the corpus.
    const cachedVideo = service.store.getSearchVideoCacheRows([outlierVideoId]).get(outlierVideoId);
    expect(cachedVideo).toBeDefined();
    expect(cachedVideo!.viewCount).toBe(999);
  });
});
