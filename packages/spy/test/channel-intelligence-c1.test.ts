import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SpyService } from '../src/index.ts';
import { SpyStore } from '../src/store.ts';

const UC = `UC${'a'.repeat(22)}`;

let root = '';
let store: SpyStore | null = null;
let spy: SpyService | null = null;

afterEach(async () => {
  spy?.store.close();
  store?.close();
  spy = null;
  store = null;
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

async function tempRoot(prefix: string): Promise<string> {
  root = await mkdtemp(join(tmpdir(), prefix));
  return root;
}

describe('Spy C1 channel roles', () => {
  test('explicitly migrates a v6 fixture and preserves legacy rows/columns', async () => {
    const dir = await tempRoot('spy-c1-migration-');
    const path = join(dir, 'spy.sqlite');
    const db = new Database(path);
    db.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version(version) VALUES (6);
      CREATE TABLE channels (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        subscriber_count INTEGER,
        video_count INTEGER,
        total_view_count INTEGER,
        fetched_at TEXT NOT NULL
      );
      INSERT INTO channels(id, channel_id, title, fetched_at)
      VALUES ('legacy-1', 'youtube:channel:/@legacy', 'Legacy', '2026-08-30T00:00:00Z');
      INSERT INTO channels(id, channel_id, title, fetched_at)
      VALUES ('legacy-2', '${UC}', 'Resolved', '2026-08-30T00:00:00Z');
      CREATE TABLE competitors (
        id TEXT PRIMARY KEY,
        owner_channel_id TEXT NOT NULL,
        competitor_channel_id TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(owner_channel_id, competitor_channel_id)
      );
      INSERT INTO competitors(id, owner_channel_id, competitor_channel_id, note, created_at)
      VALUES ('comp-1', 'legacy-owner', '${UC}', 'keep me', '2026-08-30T00:00:00Z');
    `);
    db.close();

    store = new SpyStore(path);
    const readonly = new Database(path, { readonly: true });
    expect(Number((readonly.prepare('SELECT version FROM schema_version').get() as { version: number }).version)).toBe(7);
    const channelColumns = (readonly.prepare('PRAGMA table_info(channels)').all() as Array<{ name: string }>).map((row) => row.name);
    const competitorColumns = (readonly.prepare('PRAGMA table_info(competitors)').all() as Array<{ name: string }>).map((row) => row.name);
    expect(channelColumns).toEqual(expect.arrayContaining(['channel_id', 'youtube_uc_id', 'handle']));
    expect(competitorColumns).toEqual(expect.arrayContaining([
      'watch_status', 'cadence', 'last_observed_at', 'last_observation_status',
    ]));
    const legacy = readonly.prepare('SELECT * FROM channels WHERE id=?').get('legacy-1') as Record<string, unknown>;
    expect(legacy['channel_id']).toBe('youtube:channel:/@legacy');
    expect(legacy['handle']).toBe('@legacy');
    const resolved = readonly.prepare('SELECT youtube_uc_id FROM channels WHERE id=?').get('legacy-2') as Record<string, unknown>;
    expect(resolved['youtube_uc_id']).toBe(UC);
    const competitor = readonly.prepare('SELECT note, watch_status, cadence FROM competitors WHERE id=?').get('comp-1') as Record<string, unknown>;
    expect(competitor).toMatchObject({ note: 'keep me', watch_status: 'followed', cadence: 'daily' });
    const forbiddenTables = readonly.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('owned_channels', 'oauth_tokens', 'youtube_analytics', 'competitor_observation_runs', 'video_stat_points')`,
    ).all();
    expect(forbiddenTables).toHaveLength(0);
    readonly.close();
  });

  test('star is storage-only and requires a resolved UC identity', async () => {
    const dir = await tempRoot('spy-c1-roles-');
    spy = new SpyService({ dataRoot: dir });
    await spy.init();
    spy.store.upsertChannel({
      channelId: 'youtube:channel:/@resolved', youtubeUcId: UC, handle: '@resolved',
      title: 'Resolved', subscriberCount: null, videoCount: null, totalViewCount: null,
      fetchedAt: '2026-08-30T00:00:00Z',
    });
    const beforeOperations = spy.store.databasePath;

    expect(spy.starChannel(UC, 'research')).toEqual({
      youtubeUcId: UC, starred: true, starredAt: expect.any(String),
    });
    expect(spy.store.listSavedChannels()).toHaveLength(1);
    expect(spy.store.listCompetitors('local-desktop')).toHaveLength(0);
    const operations = new Database(beforeOperations, { readonly: true });
    expect(Number((operations.prepare('SELECT COUNT(*) AS n FROM operations').get() as { n: number }).n)).toBe(0);
    operations.close();

    expect(() => spy!.starChannel('UCnot-resolved')).toThrow(/channel_unresolved_or_invalid/);
    expect(spy.unstarChannel(UC)).toEqual({ youtubeUcId: UC, starred: false });
    expect(spy.store.listSavedChannels()).toHaveLength(0);
  });

  test('local follow, pause, unfollow and summary fields use the canonical legacy relation', async () => {
    const dir = await tempRoot('spy-c1-follow-');
    spy = new SpyService({ dataRoot: dir });
    await spy.init();
    spy.store.upsertChannel({
      channelId: 'youtube:channel:/@followed', youtubeUcId: UC, handle: '@followed',
      title: 'Followed', subscriberCount: null, videoCount: null, totalViewCount: null,
      fetchedAt: '2026-08-30T00:00:00Z',
    });

    expect(spy.followChannel(UC, { note: 'watch', cadence: 'manual' })).toMatchObject({
      watchlistId: 'local-desktop', competitorChannelId: UC, watchStatus: 'followed', cadence: 'manual',
      lastObservedAt: null, nextDueAt: null,
    });
    expect(spy.updateFollowedChannel(UC, { watchStatus: 'paused' })).toMatchObject({ watchStatus: 'paused', cadence: 'manual' });
    expect(spy.listWatchlistChannels('local-desktop', 'followed')).toEqual({
      channels: [{
        youtubeUcId: UC, title: 'Followed', handle: '@followed', starred: false, starredAt: null,
        watchStatus: 'paused', cadence: 'manual', lastObservedAt: null, nextDueAt: null, note: 'watch',
      }],
      nextCursor: null,
    });
    expect(spy.unfollowChannel(UC)).toMatchObject({ removed: true, competitorChannelId: UC });
    expect(spy.store.listCompetitors('local-desktop')).toHaveLength(0);
  });
});
