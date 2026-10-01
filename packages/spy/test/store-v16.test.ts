/**
 * store-v16.test.ts — migration v14/v15 → v16 (plan spy-analyst-workflow §H
 * bước 2–3): cột thẻ lượt chạy, n_new, ngách + ngày tạo kênh; keyword_run_items
 * rebuild để CHECK nhận 'skipped_dedup' mà KHÔNG mất dòng cũ.
 *
 * Fixture: tạo DB mới (v16) rồi hạ tay về dạng v14 (DROP cột mới, rebuild
 * keyword_run_items với CHECK cũ, version=14) — mở lại bằng SpyStore.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { SCHEMA_VERSION, SpyStore } from '../src/store.ts';

let tempDir = '';
afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = '';
});

function downgradeToV14(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`
    ALTER TABLE keyword_runs DROP COLUMN type;
    ALTER TABLE keyword_runs DROP COLUMN note;
    ALTER TABLE keyword_runs DROP COLUMN group_key;
    ALTER TABLE keyword_runs DROP COLUMN triggered_by;
    ALTER TABLE keyword_runs DROP COLUMN n_new;
    ALTER TABLE keyword_runs DROP COLUMN n_skipped;
    ALTER TABLE keyword_checks DROP COLUMN n_new;
    ALTER TABLE topic_channels DROP COLUMN group_key;
    ALTER TABLE topic_channels DROP COLUMN channel_published_at;
    DROP TABLE measured_channels;
    DROP TABLE keyword_run_items;
    CREATE TABLE keyword_run_items (
      run_id TEXT NOT NULL REFERENCES keyword_runs(run_id),
      term_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('done','failed','skipped_quota')),
      n_results INTEGER, n_followed INTEGER, median_views REAL,
      outliers_found INTEGER, error TEXT,
      PRIMARY KEY (run_id, term_key)
    );
    INSERT INTO keyword_runs (run_id, topic_id, params_json, n_keywords, started_at)
      VALUES ('r-old', 'fin', '{}', 1, '2026-09-20T00:00:00.000Z');
    INSERT INTO keyword_run_items (run_id, term_key, status, n_results)
      VALUES ('r-old', 'kw', 'done', 7);
    UPDATE schema_version SET version = 14;
  `);
  db.close();
}

describe('migration v14 → v16', () => {
  test('thêm cột mới, giữ dòng cũ, CHECK nhận skipped_dedup', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'spy-store-v16-'));
    const dbPath = join(tempDir, 'spy.sqlite');
    const fresh = new SpyStore(dbPath);
    fresh.upsertTopic({ topicId: 'fin', label: 'Fin', market: 'en', language: 'en', region: 'US' });
    fresh.close();
    downgradeToV14(dbPath);

    const store = new SpyStore(dbPath);
    const check = new Database(dbPath, { readonly: true });
    const version = Number((check.prepare('SELECT version FROM schema_version').get() as { version: number }).version);
    const cols = (table: string) =>
      (check.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(version).toBe(SCHEMA_VERSION);
    expect(cols('keyword_runs')).toEqual(expect.arrayContaining(['type', 'note', 'group_key', 'triggered_by', 'n_new', 'n_skipped']));
    expect(cols('keyword_run_items')).toEqual(expect.arrayContaining(['n_new', 'skip_reason']));
    expect(cols('keyword_checks')).toContain('n_new');
    expect(cols('topic_channels')).toEqual(expect.arrayContaining(['group_key', 'channel_published_at']));
    expect(cols('measured_channels')).toEqual(expect.arrayContaining(['group_key', 'channel_published_at']));
    check.close();

    // Dòng cũ nguyên vẹn; run cũ mặc định là Tìm mới do người bấm.
    const old = store.getKeywordRun('r-old')!;
    expect(old.run['type']).toBe('discover');
    expect(old.run['triggered_by']).toBe('human');
    expect(old.items.map((i) => [i['term_key'], i['status'], i['n_results']])).toEqual([['kw', 'done', 7]]);

    store.insertKeywordRunItem({ runId: 'r-old', termKey: 'kw2', status: 'skipped_dedup', skipReason: 'searched_at:x' });
    expect(store.getKeywordRun('r-old')!.items.find((i) => i['term_key'] === 'kw2')!['skip_reason']).toBe('searched_at:x');
    store.close();
  });

  test('assignChannelNiche đè ngách ở cả sổ theo dõi lẫn sổ đo', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'spy-store-v16-'));
    const store = new SpyStore(join(tempDir, 'spy.sqlite'));
    store.upsertTopic({ topicId: 'fin', label: 'Fin', market: 'en', language: 'en', region: 'US' });
    store.upsertTopicChannel({ topicId: 'fin', channelId: 'UCa', status: 'active', title: 'A' });
    store.setTopicChannelMeta('fin', 'UCa', { groupKey: 'first' });
    store.setTopicChannelMeta('fin', 'UCa', { groupKey: 'second' });
    expect(store.listTopicChannelsByStatus('fin', ['active'])[0]!.groupKey).toBe('first');
    store.upsertMeasuredChannel({
      topicId: 'fin', channelId: 'UCb', title: 'B', subscriberCount: 100, baselineMedianViews: 10,
      baselineN: 3, maxViews: 20, verdict: 'unreliable', hitOutlierScore: null,
      discoveredVia: 'keyword_run', discoveredFrom: 'kw', measuredAt: '2026-09-29T00:00:00.000Z', groupKey: 'first',
    });
    expect(store.assignChannelNiche('fin', ['UCa', 'UCb', 'UCnone'], 'manual')).toBe(2);
    expect(store.listTopicChannelsByStatus('fin', ['active'])[0]!.groupKey).toBe('manual');
    expect(store.listMeasuredChannels('fin')[0]!.groupKey).toBe('manual');
    store.close();
  });
});
