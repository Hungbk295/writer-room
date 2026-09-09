import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { SCHEMA_VERSION, SpyStore } from '../src/store.ts';
import { SpyService } from '../src/index.ts';
import type { YouTubeDataApiPort, VideoStatistics } from '../src/adapters/data-api.ts';
import type { YoutubePort, YoutubeVideoInfo } from '../src/adapters/ytdlp.ts';

/**
 * v10 root-cause fix: video_snapshots gained a real `channel_id` FK to
 * `channels.id`. Before it existed, corpusChannelStats() had to guess a
 * video's channel from "which spy_run produced its newest row" — the actual
 * root cause of the Hidden Yield incident (channel average reported as
 * 3,668 instead of correctly including a 380,079-view video, a 45x
 * understatement) after a lone spy_video_start run touched an
 * already-scanned video.
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe('video_snapshots.channel_id backfill (v9 -> v10)', () => {
  test('matches by trimmed title, prefers the channels row with youtube_uc_id on a duplicate title, and leaves the median/max of every channel unchanged', async () => {
    const dir = await tempRoot('spy-channel-backfill-');
    const path = join(dir, 'spy.sqlite');
    const db = new Database(path);
    db.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version(version) VALUES (8);

      CREATE TABLE channels (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL UNIQUE,
        youtube_uc_id TEXT,
        handle TEXT,
        title TEXT NOT NULL,
        subscriber_count INTEGER,
        video_count INTEGER,
        total_view_count INTEGER,
        fetched_at TEXT NOT NULL
      );

      CREATE TABLE video_snapshots (
        id TEXT PRIMARY KEY,
        spy_run_id TEXT NOT NULL,
        source_video_id TEXT NOT NULL,
        canonical_url TEXT NOT NULL,
        title TEXT NOT NULL,
        channel_title TEXT NOT NULL DEFAULT '',
        rank INTEGER NOT NULL,
        view_count INTEGER NOT NULL,
        like_count INTEGER,
        comment_count INTEGER,
        duration_sec REAL NOT NULL,
        published_at TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        transcript_status TEXT NOT NULL,
        transcript_source TEXT,
        frame_status TEXT NOT NULL,
        thumbnail_json TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(spy_run_id, source_video_id)
      );
    `);

    // Real-data case #1: channels.title has a trailing space
    // ("Finance With Ryan "), video_snapshots.channel_title does not.
    // trim() on both sides must still match them.
    db.prepare(
      `INSERT INTO channels(id, channel_id, title, fetched_at) VALUES (?,?,?,?)`,
    ).run('chan-ryan', 'youtube:channel:/@financewithryan', 'Finance With Ryan ', '2026-08-01T00:00:00Z');

    // Real-data case #2: two channels rows share a title (pre-existing
    // duplicate-channel debt) — the row WITH a resolved youtube_uc_id must
    // win, since that's the row C1 roles/follow/star treat as canonical.
    db.prepare(
      `INSERT INTO channels(id, channel_id, youtube_uc_id, title, fetched_at) VALUES (?,?,?,?,?)`,
    ).run('chan-abtc-nouc', 'youtube:channel:/@anhbataichinh-88', null, 'Anh Ba Tài Chính', '2026-08-01T00:00:00Z');
    const abtcUcId = `UC${'a'.repeat(22)}`;
    db.prepare(
      `INSERT INTO channels(id, channel_id, youtube_uc_id, title, fetched_at) VALUES (?,?,?,?,?)`,
    ).run('chan-abtc-uc', 'youtube:channel:/channel/' + abtcUcId.toLowerCase(), abtcUcId, 'Anh Ba Tài Chính', '2026-08-01T00:00:00Z');

    const insertSnapshot = db.prepare(`
      INSERT INTO video_snapshots
        (id, spy_run_id, source_video_id, canonical_url, title, channel_title, rank,
         view_count, duration_sec, published_at, transcript_status, frame_status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const snapshot = (sourceVideoId: string, channelTitle: string, viewCount: number, createdAt: string) => {
      insertSnapshot.run(
        randomUUID(), 'run-fixture', sourceVideoId,
        `https://www.youtube.com/watch?v=${sourceVideoId}`,
        `Video ${sourceVideoId}`, channelTitle, 1, viewCount, 300, '2026-01-01T00:00:00.000Z',
        'ok', 'skipped', createdAt,
      );
    };
    snapshot('ryanVideoA1', 'Finance With Ryan', 1_000, '2026-08-05T00:00:00Z');
    snapshot('ryanVideoB2', 'Finance With Ryan', 3_000, '2026-08-06T00:00:00Z');
    snapshot('abtcVideoA1', 'Anh Ba Tài Chính', 500, '2026-08-05T00:00:00Z');
    snapshot('abtcVideoB2', 'Anh Ba Tài Chính', 1_500, '2026-08-06T00:00:00Z');
    db.close();

    const store = new SpyStore(path);
    try {
      const readonly = new Database(path, { readonly: true });
      const version = Number((readonly.prepare('SELECT version FROM schema_version').get() as { version: number }).version);
      expect(version).toBe(SCHEMA_VERSION);
      readonly.close();

      const stats = store.corpusChannelStats();

      const ryan = stats.find((row) => row.channelKey === 'youtube:channel:/@financewithryan');
      expect(ryan).toBeDefined();
      expect(ryan!.videoCount).toBe(2);
      expect(ryan!.avgViews).toBeCloseTo(2_000, 3);
      expect(ryan!.maxViews).toBe(3_000);

      // Both ambiguous-title videos must land under the CANONICAL (has
      // youtube_uc_id) channels row, not the duplicate.
      const abtcCanonical = stats.find((row) => row.channelKey === 'youtube:channel:/channel/' + abtcUcId.toLowerCase());
      const abtcDuplicate = stats.find((row) => row.channelKey === 'youtube:channel:/@anhbataichinh-88');
      expect(abtcDuplicate).toBeUndefined();
      expect(abtcCanonical).toBeDefined();
      expect(abtcCanonical!.videoCount).toBe(2);
      expect(abtcCanonical!.avgViews).toBeCloseTo(1_000, 3);
      expect(abtcCanonical!.maxViews).toBe(1_500);
    } finally {
      store.close();
    }
  });
});

describe('Hidden Yield repro: channel scan then a lone video-level run', () => {
  const UC_ID = `UC${'0'.repeat(22)}`;
  const CHANNEL_URL = `https://www.youtube.com/channel/${UC_ID}`;
  const TOUCHED_VIDEO_ID = 'hyVideoBbb2';
  const TOUCHED_VIDEO_URL = `https://www.youtube.com/watch?v=${TOUCHED_VIDEO_ID}`;
  const VIDEOS: Array<{ id: string; title: string; viewCount: number }> = [
    { id: 'hyVideoAaa1', title: 'HY video A', viewCount: 100_000 },
    { id: TOUCHED_VIDEO_ID, title: 'HY video B (outlier)', viewCount: 364_468 },
    { id: 'hyVideoCcc3', title: 'HY video C', viewCount: 50_000 },
  ];
  const UPDATED_VIEW_COUNT = 380_079;

  function stubInfo(video: typeof VIDEOS[number]): YoutubeVideoInfo {
    return {
      sourceVideoId: video.id,
      canonicalUrl: `https://www.youtube.com/watch?v=${video.id}`,
      title: video.title,
      channelTitle: 'Hidden Yield',
      channelId: UC_ID,
      viewCount: video.viewCount,
      durationSec: 600,
      publishedAt: '2026-01-01T00:00:00.000Z',
      thumbnailUrl: null,
    };
  }

  function youtube(): YoutubePort {
    return {
      listChannel: async () => VIDEOS.map(stubInfo),
      inspectVideo: async (canonicalUrl: string) => {
        const video = VIDEOS.find((v) => canonicalUrl.includes(v.id));
        if (!video) throw new Error(`unexpected canonicalUrl ${canonicalUrl}`);
        return stubInfo(video);
      },
      streamUrl: async () => '',
      thumbnail: async () => ({ bytes: new Uint8Array(), mimeType: 'image/jpeg' }),
      fetchTranscript: async () => ({ status: 'ok', language: 'vi', source: 'manual', segments: [] }),
    } as YoutubePort;
  }

  function dataApi(): YouTubeDataApiPort {
    return {
      // Channel-scan's enrichSnapshots() call passes all 3 ids at once — a
      // no-op here so the inspectVideo() numbers above stand. The
      // video-level run's resolveVideoInfo() call passes exactly
      // [TOUCHED_VIDEO_ID] and must return the UPDATED view count with a
      // resolved channelId, exactly like a real re-fetch of an
      // already-known video would.
      async fetchVideoStatistics(ids: readonly string[]): Promise<Map<string, VideoStatistics>> {
        if (ids.length !== 1 || ids[0] !== TOUCHED_VIDEO_ID) return new Map();
        return new Map([[TOUCHED_VIDEO_ID, {
          videoId: TOUCHED_VIDEO_ID,
          likeCount: null,
          commentCount: null,
          viewCount: UPDATED_VIEW_COUNT,
          publishedAt: '2026-01-01T00:00:00.000Z',
          publishedAtPrecision: 'day' as const,
          durationSec: 600,
          tags: [],
          title: 'HY video B (outlier)',
          channelId: UC_ID,
          channelTitle: 'Hidden Yield',
          thumbnailUrl: null,
          defaultAudioLanguage: null,
          defaultLanguage: null,
        }]]);
      },
      async fetchChannelStatistics() { return new Map(); },
    };
  }

  async function waitDone(spy: SpyService, operationId: string) {
    let op = await spy.wait(operationId, 5_000);
    while (op.status === 'queued' || op.status === 'running') op = await spy.wait(operationId, 5_000);
    return op;
  }

  test('a video-level run on an already-scanned video keeps it in its channel cluster (max/count unchanged in kind, view refreshed)', async () => {
    const root = await tempRoot('spy-hidden-yield-');
    const spy = new SpyService({ dataRoot: join(root, 'spy'), youtube: youtube(), dataApi: dataApi() });
    await spy.init();

    const channelOp = spy.channelSpy({
      url: CHANNEL_URL,
      depth: 'metadata',
      scanLimit: 3,
      topN: 3,
      selectionMode: 'popular',
      rankBy: 'velocity',
      minDurationSec: 0,
      idempotencyKey: 'hy-channel-scan',
    });
    const channelDone = await waitDone(spy, channelOp.operationId);
    expect(channelDone.status).toBe('completed');

    const before = spy.store.corpusChannelStats().find((row) => row.channelKey.includes(UC_ID.toLowerCase()));
    expect(before).toBeDefined();
    expect(before!.videoCount).toBe(3);
    expect(before!.maxViews).toBe(364_468);

    // A lone spy_video_start on the outlier video, some time later — this is
    // exactly the sequence that used to corrupt the channel's cluster.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const videoOp = spy.videoSpy({
      url: TOUCHED_VIDEO_URL,
      depth: 'metadata',
      idempotencyKey: 'hy-video-touch',
    });
    const videoDone = await waitDone(spy, videoOp.operationId);
    expect(videoDone.status).toBe('completed');

    const after = spy.store.corpusChannelStats().find((row) => row.channelKey.includes(UC_ID.toLowerCase()));
    expect(after).toBeDefined();
    // The old rule (ROW_NUMBER by created_at across ALL spy_runs, keyed by
    // spy_runs.source_identity) would report videoCount 2 here — the
    // video-level run's own source_identity ('youtube:video:hyVideoBbb2')
    // differs from the channel's, so it would form a channel of its own and
    // pull hyVideoBbb2 out of Hidden Yield's cluster entirely.
    expect(after!.videoCount).toBe(3);
    expect(after!.maxViews).toBe(UPDATED_VIEW_COUNT);
  });

  test('searchCorpusVideos() keeps the same video under its channel after a lone spy_video_start (v10 channel_id, not spy_runs.source_identity)', async () => {
    const root = await tempRoot('spy-hidden-yield-search-');
    const spy = new SpyService({ dataRoot: join(root, 'spy'), youtube: youtube(), dataApi: dataApi() });
    await spy.init();

    const channelOp = spy.channelSpy({
      url: CHANNEL_URL,
      depth: 'metadata',
      scanLimit: 3,
      topN: 3,
      selectionMode: 'popular',
      rankBy: 'velocity',
      minDurationSec: 0,
      idempotencyKey: 'hy-search-channel-scan',
    });
    expect((await waitDone(spy, channelOp.operationId)).status).toBe('completed');

    const beforeRows = spy.store.searchCorpusVideos({ sourceVideoIds: [TOUCHED_VIDEO_ID] });
    expect(beforeRows).toHaveLength(1);
    expect(beforeRows[0]!.channelKey.toLowerCase()).toContain(UC_ID.toLowerCase());

    // A lone spy_video_start on that same video, with its OWN spy_run whose
    // source_identity is 'youtube:video:hyVideoBbb2' — under the old rule
    // (ROW_NUMBER over spy_runs.source_identity across ALL runs) this would
    // become the video's "newest" row and report that video-run's own
    // source_identity as its channel, not Hidden Yield's.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const videoOp = spy.videoSpy({
      url: TOUCHED_VIDEO_URL,
      depth: 'metadata',
      idempotencyKey: 'hy-search-video-touch',
    });
    expect((await waitDone(spy, videoOp.operationId)).status).toBe('completed');

    const afterRows = spy.store.searchCorpusVideos({ sourceVideoIds: [TOUCHED_VIDEO_ID] });
    expect(afterRows).toHaveLength(1);
    expect(afterRows[0]!.channelKey.toLowerCase()).toContain(UC_ID.toLowerCase());
    expect(afterRows[0]!.channelKey).not.toContain('youtube:video:');
    expect(afterRows[0]!.viewCount).toBe(UPDATED_VIEW_COUNT);

    // A filter by the channel's own id must still find the video afterwards.
    const byChannel = spy.store.searchCorpusVideos({ channelIds: [UC_ID], limit: 10 });
    expect(byChannel.map((row) => row.sourceVideoId)).toContain(TOUCHED_VIDEO_ID);
  });
});
