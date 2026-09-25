/**
 * store-v13.test.ts — Spy Pipeline v3 Lean (plan §4): migration v12→v13 +
 * toàn bộ hợp đồng store mới.
 *
 * Fixture v12 được dựng thủ công (DDL cũ + dữ liệu status cũ) rồi mở bằng
 * SpyStore — constructor chạy migrate12To13 trong transaction.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { DEFAULT_TOPIC_SETTINGS, SpyStore } from '../src/store.ts';
import { AppError } from '../src/errors.ts';

let tempDir = '';
const openStores: SpyStore[] = [];

afterEach(async () => {
  for (const store of openStores.splice(0)) store.close();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = '';
});

async function setupStore() {
  tempDir = await mkdtemp(join(tmpdir(), 'spy-store-v13-'));
  const store = new SpyStore(join(tempDir, 'spy.sqlite'));
  openStores.push(store);
  return store;
}

/**
 * DDL tối thiểu của một DB v12 thật (v5 tables + cột thêm sau bằng
 * V5_ADDED_COLUMNS). SpyStore mở sẽ chạy migrate12To13.
 */
const V12_DDL = `
CREATE TABLE schema_version (version INTEGER NOT NULL);
INSERT INTO schema_version VALUES (12);

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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE topic_keywords (
  topic_id TEXT NOT NULL,
  term_key TEXT NOT NULL,
  display_term TEXT NOT NULL,
  relation TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','searched','exhausted','rejected')),
  yield_channels INTEGER NOT NULL DEFAULT 0,
  last_searched_at TEXT,
  added_at TEXT NOT NULL,
  added_by TEXT NOT NULL DEFAULT 'user' CHECK(added_by IN ('user','loop','agent')),
  PRIMARY KEY (topic_id, term_key)
);

CREATE TABLE topic_channel_sources (
  topic_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  term_key TEXT,
  from_channel_id TEXT,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (topic_id, channel_id, relation)
);

CREATE TABLE topic_channels (
  topic_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  fit_score REAL,
  fit_reasons_json TEXT NOT NULL DEFAULT '[]',
  faceless_score REAL,
  faceless_signals_json TEXT NOT NULL DEFAULT '[]',
  faceless_hint REAL,
  faceless_hint_reasons_json TEXT,
  thumbnails_json TEXT,
  style_match_score REAL,
  style_notes TEXT,
  learn_value_score REAL,
  learn_value_reasons_json TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','shortlisted','studied','rejected','own')),
  decided_by TEXT CHECK(decided_by IN ('user','loop_auto')),
  decided_at TEXT,
  decided_reason TEXT,
  spy_run_id TEXT,
  lang_detected TEXT,
  lang_confidence REAL,
  lang_evidence_json TEXT,
  first_seen_at TEXT NOT NULL,
  last_scored_at TEXT,
  PRIMARY KEY (topic_id, channel_id)
);
CREATE INDEX idx_topic_channels_status_fit ON topic_channels(topic_id, status, fit_score DESC);

CREATE TABLE loop_ticks (
  tick_id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,
  quota_day TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','done','failed','skipped_quota')),
  step TEXT NOT NULL DEFAULT 'expand',
  search_calls_used INTEGER NOT NULL DEFAULT 0,
  general_units_used INTEGER NOT NULL DEFAULT 0,
  search_baseline_calls INTEGER NOT NULL DEFAULT 0,
  general_baseline_units INTEGER NOT NULL DEFAULT 0,
  keywords_searched_json TEXT NOT NULL DEFAULT '[]',
  new_candidates INTEGER NOT NULL DEFAULT 0,
  new_shortlisted_auto INTEGER NOT NULL DEFAULT 0,
  scanned_channels INTEGER NOT NULL DEFAULT 0,
  keywords_harvested INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  UNIQUE(topic_id, quota_day)
);

CREATE TABLE daily_reports (
  report_id TEXT PRIMARY KEY,
  report_date TEXT NOT NULL,
  topic_id TEXT,
  summary_json TEXT NOT NULL,
  markdown TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  delivered_json TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX uq_daily_reports_topic_date
  ON daily_reports(COALESCE(topic_id, ''), report_date);
`;

/** DB v12 có đủ mọi biến thể status cũ để kiểm mapping. */
async function setupV12Fixture(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), 'spy-v12-fixture-'));
  const path = join(tempDir, 'spy.sqlite');
  const db = new Database(path);
  db.exec(V12_DDL);
  db.exec(`
    INSERT INTO topics (topic_id, label, market, language, created_at, updated_at)
    VALUES ('fin', 'Finance', 'us', 'en', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
    INSERT INTO topic_keywords (topic_id, term_key, display_term, relation, status, yield_channels, added_at, added_by)
    VALUES
      ('fin', 'kw_pending', 'pending kw', 'seed', 'pending', 0, '2026-08-01T00:00:00Z', 'user'),
      ('fin', 'kw_searched', 'searched kw', 'seed', 'searched', 4, '2026-08-01T00:00:00Z', 'user'),
      ('fin', 'kw_exhausted', 'exhausted kw', 'harvested_title', 'exhausted', 1, '2026-08-02T00:00:00Z', 'loop'),
      ('fin', 'kw_rejected', 'rejected kw', 'llm_expand', 'rejected', 0, '2026-08-02T00:00:00Z', 'loop');
    INSERT INTO topic_channels (topic_id, channel_id, status, decided_by, fit_score, first_seen_at)
    VALUES
      ('fin', 'UC_new', 'new', NULL, 10, '2026-08-01T00:00:00Z'),
      ('fin', 'UC_short_user', 'shortlisted', 'user', 20, '2026-08-01T00:00:00Z'),
      ('fin', 'UC_short_loop', 'shortlisted', 'loop_auto', 30, '2026-08-01T00:00:00Z'),
      ('fin', 'UC_short_null', 'shortlisted', NULL, 40, '2026-08-01T00:00:00Z'),
      ('fin', 'UC_studied', 'studied', 'user', 50, '2026-08-01T00:00:00Z'),
      ('fin', 'UC_rejected', 'rejected', 'user', 60, '2026-08-01T00:00:00Z'),
      ('fin', 'UC_own', 'own', 'user', 70, '2026-08-01T00:00:00Z');
    INSERT INTO loop_ticks (tick_id, topic_id, quota_day, started_at, status)
    VALUES ('tick-1', 'fin', '2026-08-20', '2026-08-20T15:30:00Z', 'done');
    INSERT INTO daily_reports (report_id, report_date, topic_id, summary_json, markdown, created_at)
    VALUES ('rep-1', '2026-08-20', 'fin', '{}', '', '2026-08-20T16:00:00Z');
  `);
  db.close();
  return path;
}

describe('v12 → v13 migration', () => {
  test('map status topic_keywords + topic_channels, giữ nguyên dữ liệu', async () => {
    const path = await setupV12Fixture();
    const store = new SpyStore(path);
    openStores.push(store);

    const raw = new Database(path, { readonly: true });
    expect(Number((raw.prepare('SELECT version FROM schema_version').get() as { version: number }).version)).toBe(13);

    const kws = raw.prepare('SELECT term_key, status, origin FROM topic_keywords ORDER BY term_key').all() as Array<Record<string, unknown>>;
    const kwStatus = Object.fromEntries(kws.map((k) => [String(k['term_key']), String(k['status'])]));
    expect(kwStatus).toEqual({
      kw_exhausted: 'paused',
      kw_pending: 'pending',
      kw_rejected: 'rejected',
      kw_searched: 'active',
    });
    // origin suy ra từ relation cũ: seed→seed, harvested_title→title_ngram,
    // llm_expand do loop thêm → NULL (không đoán bừa).
    const kwOrigin = Object.fromEntries(kws.map((k) => [String(k['term_key']), k['origin']]));
    expect(kwOrigin['kw_searched']).toBe('seed');
    expect(kwOrigin['kw_exhausted']).toBe('title_ngram');
    expect(kwOrigin['kw_rejected']).toBeNull();

    const chans = raw.prepare('SELECT channel_id, status, decided_by FROM topic_channels').all() as Array<Record<string, unknown>>;
    const chStatus = Object.fromEntries(chans.map((c) => [String(c['channel_id']), String(c['status'])]));
    expect(chStatus).toEqual({
      UC_new: 'new',
      UC_short_user: 'active',
      UC_short_loop: 'new',
      UC_short_null: 'new',
      UC_studied: 'active',
      UC_rejected: 'rejected',
      UC_own: 'own',
    });
    // decided_by được giữ nguyên để truy vết ai đã quyết.
    const chDecidedBy = Object.fromEntries(chans.map((c) => [String(c['channel_id']), c['decided_by']]));
    expect(chDecidedBy['UC_short_loop']).toBe('loop_auto');
    expect(chDecidedBy['UC_studied']).toBe('user');

    // fit_score sống sót qua rebuild.
    const fit = raw.prepare("SELECT fit_score FROM topic_channels WHERE channel_id='UC_studied'").get() as { fit_score: number };
    expect(fit.fit_score).toBe(50);

    // topics có 3 cột mới, tick cũ mode='daily', report cũ mode='daily'.
    const topic = raw.prepare('SELECT region, settings_json, setup_status FROM topics').get() as Record<string, unknown>;
    expect(topic['region']).toBeNull();
    expect(topic['settings_json']).toBe('{}');
    expect(topic['setup_status']).toBe('none');
    const tick = raw.prepare('SELECT mode FROM loop_ticks').get() as { mode: string };
    expect(tick.mode).toBe('daily');
    const report = raw.prepare('SELECT mode FROM daily_reports').get() as { mode: string };
    expect(report.mode).toBe('daily');

    // 3 bảng mới tồn tại.
    const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<Record<string, unknown>>)
      .map((t) => String(t['name']));
    for (const name of ['topic_videos', 'video_daily_views', 'decisions']) {
      expect(tables).toContain(name);
    }
    raw.close();
  });

  test('DB mới tinh đã ở v13 với đầy đủ bảng/cột mới', async () => {
    const store = await setupStore();
    const raw = new Database(store.databasePath, { readonly: true });
    const version = (raw.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
    expect(version).toBe(13);
    const tkCols = raw.prepare('PRAGMA table_info(topic_keywords)').all().map((c) => String((c as Record<string, unknown>)['name']));
    expect(tkCols).toContain('origin');
    expect(tkCols).toContain('last_checked_at');
    const tcCols = raw.prepare('PRAGMA table_info(topic_channels)').all().map((c) => String((c as Record<string, unknown>)['name']));
    for (const col of ['title', 'handle', 'baseline_median_views', 'suggestion', 'discovered_via']) {
      expect(tcCols).toContain(col);
    }
    raw.close();
  });

  test('CHECK mới chặn status enum cũ', async () => {
    const store = await setupStore();
    store.upsertTopic({ topicId: 'fin', label: 'F', market: 'us', language: 'en' });
    expect(() => store.upsertTopicChannel({ topicId: 'fin', channelId: 'UCx', status: 'studied' })).toThrow();
    expect(() => store.upsertTopicChannel({ topicId: 'fin', channelId: 'UCy', status: 'shortlisted' })).toThrow();
    expect(() => store.upsertTopicKeyword({ topicId: 'fin', termKey: 'kw', displayTerm: 'k', relation: 'seed', status: 'searched' })).toThrow();
  });
});

describe('v13 — topic settings & setup status', () => {
  test('getTopicSettings trả mặc định khi chưa có settings_json', async () => {
    const store = await setupStore();
    store.upsertTopic({ topicId: 'fin', label: 'F', market: 'us', language: 'en' });
    expect(store.getTopicSettings('fin')).toEqual(DEFAULT_TOPIC_SETTINGS);
    expect(store.getTopicSettings('fin').outlierMultiple).toBe(3);
  });

  test('getTopicSettings merge override snake_case, bỏ qua giá trị hỏng', async () => {
    const store = await setupStore();
    store.upsertTopic({ topicId: 'fin', label: 'F', market: 'us', language: 'en' });
    const db = new Database(store.databasePath);
    db.prepare('UPDATE topics SET settings_json=? WHERE topic_id=?')
      .run(JSON.stringify({ outlier_multiple: 5, dead_median: 'không phải số', daily_at: '07:00' }), 'fin');
    db.close();
    const settings = store.getTopicSettings('fin');
    expect(settings.outlierMultiple).toBe(5);
    expect(settings.deadMedian).toBe(500); // giá trị hỏng → giữ mặc định
    expect(settings.dailyAt).toBe('07:00');
  });

  test('getTopicSettings chịu được settings_json hỏng', async () => {
    const store = await setupStore();
    store.upsertTopic({ topicId: 'fin', label: 'F', market: 'us', language: 'en' });
    const db = new Database(store.databasePath);
    db.prepare('UPDATE topics SET settings_json=? WHERE topic_id=?').run('{{{', 'fin');
    db.close();
    expect(store.getTopicSettings('fin')).toEqual(DEFAULT_TOPIC_SETTINGS);
  });

  test('setTopicSetupStatus ghi và ném not_found khi topic thiếu', async () => {
    const store = await setupStore();
    store.upsertTopic({ topicId: 'fin', label: 'F', market: 'us', language: 'en' });
    store.setTopicSetupStatus('fin', 'awaiting_channels');
    expect(String(store.getTopic('fin')!['setup_status'])).toBe('awaiting_channels');
    expect(() => store.setTopicSetupStatus('missing', 'done')).toThrow(AppError);
  });
});

describe('v13 — topic_channels contract', () => {
  test('upsertTopicChannelCandidate chỉ tạo new + ghi decision loop', async () => {
    const store = await setupStore();
    store.upsertTopic({ topicId: 'fin', label: 'F', market: 'us', language: 'en' });

    const first = store.upsertTopicChannelCandidate({
      topicId: 'fin', channelId: 'UC1', title: 'Money Channel',
      handle: '@money', subscriberCount: 120_000,
      discoveredVia: 'weekly_outlier', discoveredFrom: 'old money',
      tickId: 'tick-9',
    });
    expect(first.inserted).toBe(true);

    const rows = store.listTopicChannelsByStatus('fin', ['new']);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('new');
    expect(rows[0]!.title).toBe('Money Channel');
    expect(rows[0]!.discoveredVia).toBe('weekly_outlier');

    const decisions = store.listDecisions('fin');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.actor).toBe('loop');
    expect(decisions[0]!.toStatus).toBe('new');
    expect(decisions[0]!.tickId).toBe('tick-9');
  });

  test('upsertTopicChannelCandidate không đè status đã quyết định', async () => {
    const store = await setupStore();
    store.upsertTopic({ topicId: 'fin', label: 'F', market: 'us', language: 'en' });
    store.upsertTopicChannelCandidate({
      topicId: 'fin', channelId: 'UC1', title: 'C', discoveredVia: 'seed',
    });
    store.decideChannel('fin', 'UC1', 'active', 'người duyệt');

    const again = store.upsertTopicChannelCandidate({
      topicId: 'fin', channelId: 'UC1', title: 'C', discoveredVia: 'weekly_outlier',
    });
    expect(again.inserted).toBe(false);
    const rows = store.listTopicChannelsByStatus('fin', ['active']);
    expect(rows).toHaveLength(1);
    // Không sinh thêm decision khi không chèn được.
    expect(store.listDecisions('fin', { entityType: 'channel', entityId: 'UC1' })).toHaveLength(2);
  });

  test('rejectChannelForLanguage: rejected + loop_auto + lang_mismatch + decision', async () => {
    const store = await setupStore();
    store.upsertTopic({ topicId: 'fin', label: 'F', market: 'us', language: 'en' });
    store.upsertTopicChannelCandidate({ topicId: 'fin', channelId: 'UC1', title: 'C', discoveredVia: 'seed' });

    store.rejectChannelForLanguage('fin', 'UC1', '{"method":"titles"}', 'tick-1');
    const rows = store.listTopicChannelsByStatus('fin', ['rejected']);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.decidedBy).toBe('loop_auto');
    expect(rows[0]!.decidedReason).toBe('lang_mismatch');
    expect(rows[0]!.langEvidenceJson).toBe('{"method":"titles"}');

    const decisions = store.listDecisions('fin', { entityType: 'channel', entityId: 'UC1' });
    const reject = decisions.find((d) => d.toStatus === 'rejected')!;
    expect(reject.actor).toBe('loop');
    expect(reject.reason).toBe('lang_mismatch');
    expect(reject.fromStatus).toBe('new');
    expect(reject.tickId).toBe('tick-1');

    expect(() => store.rejectChannelForLanguage('fin', 'UCmissing', '{}')).toThrow(AppError);
  });

  test('updateChannelBaseline + setChannelSuggestion set/clear', async () => {
    const store = await setupStore();
    store.upsertTopic({ topicId: 'fin', label: 'F', market: 'us', language: 'en' });
    store.upsertTopicChannelCandidate({ topicId: 'fin', channelId: 'UC1', title: 'C', discoveredVia: 'seed' });

    store.updateChannelBaseline('fin', 'UC1', {
      baselineMedianViews: 12_000,
      baselineN: 30,
      maxViews: 80_000,
      lastPublishedAt: '2026-09-01T00:00:00Z',
      lastCheckedAt: '2026-09-25T00:00:00Z',
    });
    store.setChannelSuggestion('fin', 'UC1', 'pause_silent');

    const row = store.listTopicChannelsByStatus('fin', ['new'])[0]!;
    expect(row.baselineMedianViews).toBe(12_000);
    expect(row.baselineN).toBe(30);
    expect(row.maxViews).toBe(80_000);
    expect(row.baselineAt).not.toBeNull();
    expect(row.lastPublishedAt).toBe('2026-09-01T00:00:00Z');
    expect(row.suggestion).toBe('pause_silent');
    expect(row.suggestionAt).not.toBeNull();

    store.setChannelSuggestion('fin', 'UC1', null);
    const cleared = store.listTopicChannelsByStatus('fin', ['new'])[0]!;
    expect(cleared.suggestion).toBeNull();
    expect(cleared.suggestionAt).toBeNull();
    // Suggestion không bao giờ đổi status.
    expect(cleared.status).toBe('new');
  });
});

describe('v13 — topic_videos + video_daily_views', () => {
  test('upsertTopicVideo cập nhật latest_* và giữ provenance', async () => {
    const store = await setupStore();
    store.upsertTopic({ topicId: 'fin', label: 'F', market: 'us', language: 'en' });
    store.upsertTopicVideo({
      topicId: 'fin', videoId: 'v1', channelId: 'UC1', title: 'Video A',
      publishedAt: '2026-09-20T00:00:00Z', durationSec: 500,
      source: 'daily_scan', views: 1000, capturedAt: '2026-09-25T00:00:00Z',
    });
    store.upsertTopicVideo({
      topicId: 'fin', videoId: 'v1', channelId: 'UC1', title: 'Video A',
      source: 'weekly_search', foundByKeyword: 'old money',
      views: 1500, likes: 30, comments: 5, capturedAt: '2026-09-26T00:00:00Z',
    });
    const rows = store.listTopicVideos('fin');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.latestViews).toBe(1500);
    expect(rows[0]!.latestLikes).toBe(30);
    expect(rows[0]!.source).toBe('daily_scan'); // provenance lần đầu thắng
    expect(rows[0]!.foundByKeyword).toBe('old money');
  });

  test('recordVideoDailyView INSERT OR IGNORE + list DESC', async () => {
    const store = await setupStore();
    store.upsertTopic({ topicId: 'fin', label: 'F', market: 'us', language: 'en' });
    const first = store.recordVideoDailyView({
      topicId: 'fin', videoId: 'v1', day: '2026-09-24', views: 100, capturedAt: '2026-09-24T10:00:00Z',
    });
    const dup = store.recordVideoDailyView({
      topicId: 'fin', videoId: 'v1', day: '2026-09-24', views: 999, capturedAt: '2026-09-24T20:00:00Z',
    });
    store.recordVideoDailyView({
      topicId: 'fin', videoId: 'v1', day: '2026-09-25', views: 250, capturedAt: '2026-09-25T10:00:00Z',
    });
    expect(first.inserted).toBe(true);
    expect(dup.inserted).toBe(false);

    const views = store.listVideoDailyViews('fin', 'v1');
    expect(views).toHaveLength(2);
    // DESC theo day; snapshot đầu tiên của ngày thắng (không bị ghi đè).
    expect(views[0]).toEqual({ day: '2026-09-25', views: 250 });
    expect(views[1]).toEqual({ day: '2026-09-24', views: 100 });
  });

  test('updateVideoDerived + listTopicVideos filter', async () => {
    const store = await setupStore();
    store.upsertTopic({ topicId: 'fin', label: 'F', market: 'us', language: 'en' });
    for (const [videoId, channelId, views, publishedAt] of [
      ['v1', 'UC1', 100, '2026-09-20T00:00:00Z'],
      ['v2', 'UC1', 9000, '2026-09-22T00:00:00Z'],
      ['v3', 'UC2', 500, '2026-09-24T00:00:00Z'],
    ] as const) {
      store.upsertTopicVideo({
        topicId: 'fin', videoId, channelId, title: `T-${videoId}`,
        publishedAt, source: 'daily_scan', views, capturedAt: '2026-09-25T00:00:00Z',
      });
    }
    store.updateVideoDerived('fin', 'v1', { viewsGained24h: null, outlierScore: null });
    store.updateVideoDerived('fin', 'v2', { viewsGained24h: 4000, outlierScore: 4.5 });
    store.updateVideoDerived('fin', 'v3', { viewsGained24h: 50, outlierScore: 1.2 });

    const outliers = store.listTopicVideos('fin', { minOutlier: 3 });
    expect(outliers.map((v) => v.videoId)).toEqual(['v2']);
    const byChannel = store.listTopicVideos('fin', { channelId: 'UC1' });
    expect(byChannel).toHaveLength(2);
    const recent = store.listTopicVideos('fin', { publishedAfter: '2026-09-23T00:00:00Z' });
    expect(recent.map((v) => v.videoId)).toEqual(['v3']);
    expect(store.listTopicVideos('fin', { source: 'weekly_search' })).toHaveLength(0);
  });
});

describe('v13 — keyword contract', () => {
  test('upsertKeywordCandidate chỉ tạo pending + ghi decision loop', async () => {
    const store = await setupStore();
    store.upsertTopic({ topicId: 'fin', label: 'F', market: 'us', language: 'en' });

    const first = store.upsertKeywordCandidate({
      topicId: 'fin', termKey: 'old_money', displayTerm: 'old money',
      origin: 'outlier_title', evidenceJson: '{"n_videos":3}', tickId: 'tick-w1',
    });
    expect(first.inserted).toBe(true);

    const rows = store.listKeywordsByStatus('fin', ['pending']);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.origin).toBe('outlier_title');
    expect(rows[0]!.addedBy).toBe('loop');

    const dup = store.upsertKeywordCandidate({
      topicId: 'fin', termKey: 'old_money', displayTerm: 'old money',
      origin: 'outlier_title', evidenceJson: '{}',
    });
    expect(dup.inserted).toBe(false);

    const decisions = store.listDecisions('fin', { entityType: 'keyword' });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.actor).toBe('loop');
    expect(decisions[0]!.toStatus).toBe('pending');
    expect(decisions[0]!.reason).toBe('candidate:outlier_title');
  });

  test('updateKeywordCheck ghi sức khoẻ search + last_searched_at tương thích', async () => {
    const store = await setupStore();
    store.upsertTopic({ topicId: 'fin', label: 'F', market: 'us', language: 'en' });
    store.upsertKeywordCandidate({
      topicId: 'fin', termKey: 'kw1', displayTerm: 'kw', origin: 'seed', evidenceJson: '{}',
    });
    store.updateKeywordCheck('fin', 'kw1', {
      lastCheckedAt: '2026-09-25T08:00:00Z',
      lastNResults: 18,
      lastNFollowed: 6,
      lastMedianViews: 42_000,
    });
    const row = store.listKeywordsByStatus('fin', ['pending'])[0]!;
    expect(row.lastCheckedAt).toBe('2026-09-25T08:00:00Z');
    expect(row.lastNResults).toBe(18);
    expect(row.lastNFollowed).toBe(6);
    expect(row.lastMedianViews).toBe(42_000);
    expect(row.lastSearchedAt).toBe('2026-09-25T08:00:00Z');
  });
});

describe('v13 — decide (human) + decisions audit', () => {
  test('decideChannel chuyển status, ghi decision actor=human', async () => {
    const store = await setupStore();
    store.upsertTopic({ topicId: 'fin', label: 'F', market: 'us', language: 'en' });
    store.upsertTopicChannelCandidate({ topicId: 'fin', channelId: 'UC1', title: 'C', discoveredVia: 'seed' });

    store.decideChannel('fin', 'UC1', 'active', 'kênh tốt');
    const row = store.listTopicChannelsByStatus('fin', ['active'])[0]!;
    expect(row.decidedBy).toBe('user');
    expect(row.decidedReason).toBe('kênh tốt');

    const decisions = store.listDecisions('fin', { entityType: 'channel', entityId: 'UC1' });
    const human = decisions.find((d) => d.actor === 'human')!;
    expect(human.fromStatus).toBe('new');
    expect(human.toStatus).toBe('active');
    expect(human.reason).toBe('kênh tốt');

    expect(() => store.decideChannel('fin', 'UC1', 'shortlisted', null)).toThrow(AppError);
    expect(() => store.decideChannel('fin', 'UCmissing', 'active', null)).toThrow(AppError);
  });

  test('decideKeyword chuyển status, ghi decision actor=human', async () => {
    const store = await setupStore();
    store.upsertTopic({ topicId: 'fin', label: 'F', market: 'us', language: 'en' });
    store.upsertKeywordCandidate({
      topicId: 'fin', termKey: 'kw1', displayTerm: 'kw', origin: 'title_ngram', evidenceJson: '{}',
    });

    store.decideKeyword('fin', 'kw1', 'active', 'duyệt');
    const row = store.listKeywordsByStatus('fin', ['active'])[0]!;
    expect(row.decidedReason).toBe('duyệt');
    expect(row.decidedAt).not.toBeNull();

    const decisions = store.listDecisions('fin', { entityType: 'keyword', entityId: 'kw1' });
    const human = decisions.find((d) => d.actor === 'human')!;
    expect(human.fromStatus).toBe('pending');
    expect(human.toStatus).toBe('active');

    expect(() => store.decideKeyword('fin', 'kw1', 'new', null)).toThrow(AppError);
  });

  test('HITL: decisions của loop chỉ có new/pending/rejected(lang_mismatch)', async () => {
    const store = await setupStore();
    store.upsertTopic({ topicId: 'fin', label: 'F', market: 'us', language: 'en' });
    store.upsertTopicChannelCandidate({ topicId: 'fin', channelId: 'UC1', title: 'C1', discoveredVia: 'seed' });
    store.upsertTopicChannelCandidate({ topicId: 'fin', channelId: 'UC2', title: 'C2', discoveredVia: 'seed' });
    store.rejectChannelForLanguage('fin', 'UC2', '{}');
    store.upsertKeywordCandidate({ topicId: 'fin', termKey: 'kw', displayTerm: 'kw', origin: 'seed', evidenceJson: '{}' });

    const loopDecisions = store.listDecisions('fin').filter((d) => d.actor === 'loop');
    for (const d of loopDecisions) {
      expect(['new', 'pending', 'rejected']).toContain(d.toStatus);
      if (d.toStatus === 'rejected') expect(d.reason).toBe('lang_mismatch');
    }
    expect(loopDecisions).toHaveLength(4);
  });
});

describe('v13 — loop_ticks mode + daily_reports mode', () => {
  test('createLoopTick: cùng quota_day khác mode được, trùng mode thì không', async () => {
    const store = await setupStore();
    const day = '2026-09-25';
    expect(store.createLoopTick({ tickId: randomUUID(), topicId: 'fin', quotaDay: day, mode: 'daily' })).toBe(true);
    expect(store.createLoopTick({ tickId: randomUUID(), topicId: 'fin', quotaDay: day, mode: 'weekly' })).toBe(true);
    expect(store.createLoopTick({ tickId: randomUUID(), topicId: 'fin', quotaDay: day, mode: 'setup' })).toBe(true);
    // Trùng (topic, day, mode) → false.
    expect(store.createLoopTick({ tickId: randomUUID(), topicId: 'fin', quotaDay: day, mode: 'daily' })).toBe(false);
    // insertLoopTick legacy → mode 'daily'.
    const legacy = store.insertLoopTick({ tickId: randomUUID(), topicId: 'fin', quotaDay: '2026-09-26' });
    expect(legacy).toBe(true);
    const tick = store.getTickByDay('fin', '2026-09-26');
    expect(String(tick!['mode'])).toBe('daily');
  });

  test('getTickByDay/getLastTick lọc theo mode khi truyền', async () => {
    const store = await setupStore();
    const day = '2026-09-25';
    const dailyId = randomUUID();
    const weeklyId = randomUUID();
    store.createLoopTick({ tickId: dailyId, topicId: 'fin', quotaDay: day, mode: 'daily' });
    store.createLoopTick({ tickId: weeklyId, topicId: 'fin', quotaDay: day, mode: 'weekly' });
    // Cùng ngày 2 mode — mỗi mode trả đúng row của nó.
    expect(store.getTickByDay('fin', day, 'daily')!['tick_id']).toBe(dailyId);
    expect(store.getTickByDay('fin', day, 'weekly')!['tick_id']).toBe(weeklyId);
    expect(store.getTickByDay('fin', day, 'setup')).toBeNull();
    // getLastTick theo mode — chỉ thấy nhịp của mode đó.
    expect(store.getLastTick('fin', 'weekly')!['tick_id']).toBe(weeklyId);
    expect(store.getLastTick('fin', 'setup')).toBeNull();
    // Không truyền mode = hành vi cũ: tick mới nhất bất kể mode.
    expect(['daily', 'weekly']).toContain(String(store.getLastTick('fin')!['mode']));
  });

  test('daily_reports unique theo (topic, ngày, mode)', async () => {
    const store = await setupStore();
    const base = { reportDate: '2026-09-25', topicId: 'fin', summaryJson: '{}', markdown: '' };
    const daily = store.insertDailyReportOnce({ ...base, reportId: randomUUID(), mode: 'daily' });
    const weekly = store.insertDailyReportOnce({ ...base, reportId: randomUUID(), mode: 'weekly' });
    const dupDaily = store.insertDailyReportOnce({ ...base, reportId: randomUUID(), mode: 'daily' });
    expect(daily.created).toBe(true);
    expect(weekly.created).toBe(true);
    expect(dupDaily.created).toBe(false);
    expect(dupDaily.reportId).toBe(daily.reportId);
    expect(store.getDailyReportByDate('fin', '2026-09-25', 'weekly')!['report_id']).toBe(weekly.reportId);
    expect(store.getDailyReportByDate('fin', '2026-09-25')!['report_id']).toBe(daily.reportId);
  });
});
