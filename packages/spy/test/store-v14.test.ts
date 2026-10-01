/**
 * store-v14.test.ts — Spy Keyword Run + Board (plan spy-keyword-run-board §3):
 * migration v13→v14 (group_key trên topic_keywords) + hợp đồng store mới
 * (keyword_runs / keyword_run_items / keyword_checks append-only).
 *
 * Fixture v13 dựng thủ công bằng DDL cũ (topic_keywords KHÔNG có group_key)
 * rồi mở bằng SpyStore — constructor chạy migrate13To14 trong transaction.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { SpyStore } from '../src/store.ts';

let tempDir = '';
const openStores: SpyStore[] = [];

afterEach(async () => {
  for (const store of openStores.splice(0)) store.close();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = '';
});

async function setupStore(dbName = 'spy.sqlite') {
  tempDir = await mkdtemp(join(tmpdir(), 'spy-store-v14-'));
  const store = new SpyStore(join(tempDir, dbName));
  openStores.push(store);
  return store;
}

/** DDL tối thiểu của DB v13 thật — topic_keywords CHƯA có group_key. */
const V13_DDL = `
CREATE TABLE schema_version (version INTEGER NOT NULL);
INSERT INTO schema_version VALUES (13);

CREATE TABLE topics (
  topic_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  market TEXT NOT NULL,
  language TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','archived')),
  own_channel_ids_json TEXT NOT NULL DEFAULT '[]',
  brief_md TEXT NOT NULL DEFAULT '',
  faceless_required INTEGER NOT NULL DEFAULT 1,
  daily_search_budget INTEGER NOT NULL DEFAULT 20,
  region TEXT,
  settings_json TEXT NOT NULL DEFAULT '{}',
  setup_status TEXT NOT NULL DEFAULT 'none'
    CHECK(setup_status IN ('none','awaiting_channels','awaiting_keywords','done')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE topic_keywords (
  topic_id TEXT NOT NULL,
  term_key TEXT NOT NULL,
  display_term TEXT NOT NULL,
  relation TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','paused','rejected')),
  origin TEXT CHECK(origin IS NULL OR origin IN ('seed','title_ngram','outlier_title','user')),
  yield_channels INTEGER NOT NULL DEFAULT 0,
  last_searched_at TEXT,
  last_checked_at TEXT,
  last_n_results INTEGER,
  last_n_followed INTEGER,
  last_median_views REAL,
  decided_at TEXT,
  decided_reason TEXT,
  added_at TEXT NOT NULL,
  added_by TEXT NOT NULL DEFAULT 'user' CHECK(added_by IN ('user','loop','agent')),
  PRIMARY KEY (topic_id, term_key)
);
`;

describe('migration v13 → v14', () => {
  test('ALTER thêm group_key, dữ liệu cũ giữ nguyên, version=14', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'spy-migrate-v14-'));
    const dbPath = join(tempDir, 'old.sqlite');
    const raw = new Database(dbPath);
    raw.exec(V13_DDL);
    raw.prepare(
      `INSERT INTO topics (topic_id, label, market, language, created_at, updated_at)
       VALUES ('fin', 'Finance VI', 'vi', 'vi', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
    ).run();
    raw.prepare(
      `INSERT INTO topic_keywords (topic_id, term_key, display_term, relation, status, origin, last_median_views, added_at, added_by)
       VALUES ('fin', 'vay_tra_gop', 'vay trả góp', 'seed', 'active', 'seed', 8000, '2026-09-10T00:00:00.000Z', 'loop')`,
    ).run();
    raw.prepare(
      `INSERT INTO topic_keywords (topic_id, term_key, display_term, relation, status, added_at, added_by)
       VALUES ('fin', 'the_tin_dung', 'thẻ tín dụng', 'seed', 'pending', '2026-09-11T00:00:00.000Z', 'user')`,
    ).run();
    raw.close();

    const store = new SpyStore(dbPath);
    openStores.push(store);

    // version nhảy 14, cột group_key có mặt.
    const check = new Database(dbPath, { readonly: true });
    const version = Number(
      (check.prepare('SELECT version FROM schema_version').get() as { version: number }).version,
    );
    const cols = check.prepare("SELECT name FROM pragma_table_info('topic_keywords')").all() as Array<{ name: string }>;
    check.close();
    expect(version).toBe(14);
    expect(cols.map((c) => c.name)).toContain('group_key');

    // Dữ liệu cũ nguyên vẹn — kể cả keyword đã active.
    // listKeywordsByStatus trả row đã map (camelCase) — listTopicKeywords giữ raw.
    const kws = store.listKeywordsByStatus('fin', ['pending', 'active', 'paused', 'rejected']);
    expect(kws.length).toBe(2);
    const k = kws.find((x) => x.termKey === 'vay_tra_gop')!;
    expect(k.status).toBe('active');
    expect(k.lastMedianViews).toBe(8_000);
    expect(k.groupKey).toBeNull();

    // Bảng/index mới tồn tại và ghi đọc được.
    store.createKeywordRun({
      runId: 'r1', topicId: 'fin', paramsJson: '{}', nKeywords: 2,
      startedAt: '2026-09-27T00:00:00.000Z',
    });
    store.insertKeywordRunItem({ runId: 'r1', termKey: 'vay_tra_gop', status: 'done', nResults: 5 });
    const got = store.getKeywordRun('r1');
    expect(got!.run['status']).toBe('running');
    expect(got!.items[0]!['term_key']).toBe('vay_tra_gop');
    store.close();
  });
});

describe('hợp đồng store v14', () => {
  test('run lifecycle + items upsert + getRunningKeywordRun + reconcile cancel', async () => {
    const store = await setupStore();
    store.upsertTopic({ topicId: 'fin', label: 'F', market: 'vi', language: 'vi' });

    store.createKeywordRun({
      runId: 'run-a', topicId: 'fin', paramsJson: '{"status":"active"}', nKeywords: 2,
      startedAt: '2026-09-27T01:00:00.000Z',
    });
    expect(store.getRunningKeywordRun('fin')!['run_id']).toBe('run-a');
    store.updateKeywordRun('run-a', { keywordsDone: 1, searchCallsUsed: 1, generalUnitsUsed: 3 });
    store.insertKeywordRunItem({ runId: 'run-a', termKey: 'a', status: 'done', nResults: 4, medianViews: 100 });
    // Upsert cùng (run_id, term_key) đè — không tạo dòng thứ hai.
    store.insertKeywordRunItem({ runId: 'run-a', termKey: 'a', status: 'done', nResults: 4, medianViews: 120, outliersFound: 2 });
    store.updateKeywordRun('run-a', {
      status: 'done', finishedAt: '2026-09-27T01:01:00.000Z', newCandidates: 1,
    });

    const got = store.getKeywordRun('run-a')!;
    expect(got.run['status']).toBe('done');
    expect(got.run['keywords_done']).toBe(1);
    expect(got.run['new_candidates']).toBe(1);
    expect(got.items.length).toBe(1);
    expect(got.items[0]!['median_views']).toBe(120);
    expect(got.items[0]!['outliers_found']).toBe(2);
    expect(store.getRunningKeywordRun('fin')).toBeNull();
    expect(store.listKeywordRuns('fin').length).toBe(1);

    // Run đang chạy bị reconcile huỷ khi daemon restart.
    store.createKeywordRun({
      runId: 'run-b', topicId: 'fin', paramsJson: '{}', nKeywords: 1,
      startedAt: '2026-09-27T02:00:00.000Z',
    });
    expect(store.getRunningKeywordRun('fin')!['run_id']).toBe('run-b');
    store.reconcileInterruptedOperations();
    expect(store.getKeywordRun('run-b')!.run['status']).toBe('cancelled');
    expect(store.getRunningKeywordRun('fin')).toBeNull();
    store.close();
  });

  test('keyword_checks append-only + updateKeywordCheck ghi luôn check kèm runId', async () => {
    const store = await setupStore();
    store.upsertTopic({ topicId: 'fin', label: 'F', market: 'vi', language: 'vi' });
    store.upsertTopicKeyword({ topicId: 'fin', termKey: 'a', displayTerm: 'a', relation: 'seed' });

    // Check của weekly (runId null) rồi của keyword run — 2 dòng PK khác nhau.
    store.updateKeywordCheck('fin', 'a', {
      lastCheckedAt: '2026-09-26T08:00:00.000Z', lastNResults: 10, lastNFollowed: 2, lastMedianViews: 500,
    });
    store.updateKeywordCheck('fin', 'a', {
      lastCheckedAt: '2026-09-27T08:00:00.000Z', lastNResults: 12, lastNFollowed: 3, lastMedianViews: 700,
      runId: 'run-1',
    });
    const checks = store.listKeywordChecks('fin', 'a');
    expect(checks.length).toBe(2);
    expect(checks[0]!['checked_at']).toBe('2026-09-27T08:00:00.000Z'); // DESC
    expect(checks[0]!['run_id']).toBe('run-1');
    expect(checks[1]!['run_id']).toBeNull();
    // last_* trên topic_keywords phản ánh lần cuối.
    const kw = store.listKeywordsByStatus('fin', ['pending', 'active', 'paused', 'rejected'])
      .find((k) => k.termKey === 'a')!;
    expect(kw.lastMedianViews).toBe(700);
    store.close();
  });

  test('group_key: upsert có group, setKeywordGroup, listTopicKeywordsByGroup', async () => {
    const store = await setupStore();
    store.upsertTopic({ topicId: 'fin', label: 'F', market: 'vi', language: 'vi' });
    store.upsertTopicKeyword({
      topicId: 'fin', termKey: 'a', displayTerm: 'a', relation: 'seed', groupKey: 'ngan-hang',
    });
    store.upsertTopicKeyword({ topicId: 'fin', termKey: 'b', displayTerm: 'b', relation: 'seed' });

    const kwA = store.listKeywordsByStatus('fin', ['pending', 'active', 'paused', 'rejected'])
      .find((k) => k.termKey === 'a')!;
    expect(kwA.groupKey).toBe('ngan-hang');
    expect(store.listTopicKeywordsByGroup('fin', 'ngan-hang').map((k) => k.termKey)).toEqual(['a']);

    store.setKeywordGroup('fin', 'b', 'the-tin-dung');
    expect(store.listTopicKeywordsByGroup('fin', 'the-tin-dung').map((k) => k.termKey)).toEqual(['b']);
    store.setKeywordGroup('fin', 'b', null);
    expect(store.listTopicKeywordsByGroup('fin', 'the-tin-dung')).toEqual([]);

    // Upsert lại KHÔNG truyền groupKey → group cũ giữ nguyên (COALESCE).
    store.upsertTopicKeyword({ topicId: 'fin', termKey: 'a', displayTerm: 'a2', relation: 'seed' });
    const kwA2 = store.listKeywordsByStatus('fin', ['pending', 'active', 'paused', 'rejected'])
      .find((k) => k.termKey === 'a')!;
    expect(kwA2.groupKey).toBe('ngan-hang');
    store.close();
  });
});
