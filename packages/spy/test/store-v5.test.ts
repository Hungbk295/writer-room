/**
 * store.test.ts — v5 additions: topics, topic_keywords, topic_channels, loop_ticks, daily_reports.
 * Chạy cùng tên file với store.test.ts hiện có nhưng chỉ test v5 DDL/CRUD.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { SpyStore } from '../src/store.ts';

let tempDir = '';
let store: SpyStore;

afterEach(async () => {
  store?.close();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = '';
});

async function setupStore() {
  tempDir = await mkdtemp(join(tmpdir(), 'spy-store-v5-'));
  store = new SpyStore(join(tempDir, 'spy.sqlite'));
}

describe('SpyStore v5 — topics', () => {
  test('upsertTopic creates and updates', async () => {
    await setupStore();
    store.upsertTopic({
      topicId: 'finance-vi',
      label: 'Tài chính cá nhân',
      market: 'vi',
      language: 'vi',
      ownChannelIds: ['UCfoo'],
      dailySearchBudget: 15,
    });
    const row = store.getTopic('finance-vi');
    expect(row).not.toBeNull();
    expect(String(row!['label'])).toBe('Tài chính cá nhân');
    expect(Number(row!['daily_search_budget'])).toBe(15);

    // Update
    store.upsertTopic({
      topicId: 'finance-vi',
      label: 'Tài chính cá nhân (updated)',
      market: 'vi',
      language: 'vi',
      dailySearchBudget: 20,
    });
    const updated = store.getTopic('finance-vi');
    expect(String(updated!['label'])).toBe('Tài chính cá nhân (updated)');
    expect(Number(updated!['daily_search_budget'])).toBe(20);
  });

  test('listTopics filters by status', async () => {
    await setupStore();
    store.upsertTopic({ topicId: 'a', label: 'A', market: 'vi', language: 'vi', status: 'active' });
    store.upsertTopic({ topicId: 'b', label: 'B', market: 'vi', language: 'vi', status: 'paused' });
    expect(store.listTopics('active')).toHaveLength(1);
    expect(store.listTopics('paused')).toHaveLength(1);
    expect(store.listTopics()).toHaveLength(2);
  });
});

describe('SpyStore v5 — topic_keywords', () => {
  test('upsertTopicKeyword and listTopicKeywords', async () => {
    await setupStore();
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi' });
    store.upsertTopicKeyword({
      topicId: 'fin',
      termKey: 'dau_tu_chung_khoan',
      displayTerm: 'đầu tư chứng khoán',
      relation: 'seed',
      addedBy: 'user',
    });
    const kws = store.listTopicKeywords('fin');
    expect(kws).toHaveLength(1);
    expect(String(kws[0]!['display_term'])).toBe('đầu tư chứng khoán');
  });

  test('markKeywordSearched updates status and yield', async () => {
    await setupStore();
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi' });
    store.upsertTopicKeyword({
      topicId: 'fin',
      termKey: 'keyword1',
      displayTerm: 'keyword',
      relation: 'seed',
    });
    store.markKeywordSearched('fin', 'keyword1', 5);
    const kws = store.listTopicKeywords('fin');
    // v13: 'searched' → 'active' (keyword đã từng search = đang theo dõi).
    expect(String(kws[0]!['status'])).toBe('active');
    expect(Number(kws[0]!['yield_channels'])).toBe(5);
    expect(kws[0]!['last_searched_at']).not.toBeNull();
  });
});

describe('SpyStore v5 — topic_channels', () => {
  test('upsertTopicChannel and listTopicChannels', async () => {
    await setupStore();
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi' });
    store.upsertTopicChannel({
      topicId: 'fin',
      channelId: 'UCtest123',
      fitScore: 75,
      facelessScore: 0.85,
      learnValueScore: 60,
      status: 'new',
    });
    const rows = store.listTopicChannels('fin');
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!['fit_score'])).toBe(75);
    expect(Number(rows[0]!['faceless_score'])).toBe(0.85);
  });

  test('decideTopicChannels updates status', async () => {
    await setupStore();
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi' });
    store.upsertTopicChannel({
      topicId: 'fin',
      channelId: 'UCtest123',
      fitScore: 80,
      facelessScore: 0.9,
      learnValueScore: 65,
      status: 'new',
    });
    store.decideTopicChannels('fin', ['UCtest123'], 'active', 'user');
    const rows = store.listTopicChannels('fin');
    expect(String(rows[0]!['status'])).toBe('active');
    expect(String(rows[0]!['decided_by'])).toBe('user');
  });

  test('countTopicChannelsByStatus', async () => {
    await setupStore();
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi' });
    store.upsertTopicChannel({ topicId: 'fin', channelId: 'UC1', status: 'new' });
    store.upsertTopicChannel({ topicId: 'fin', channelId: 'UC2', status: 'active' });
    store.upsertTopicChannel({ topicId: 'fin', channelId: 'UC3', status: 'rejected' });
    const counts = store.countTopicChannelsByStatus('fin');
    expect(counts['new']).toBe(1);
    expect(counts['active']).toBe(1);
    expect(counts['rejected']).toBe(1);
  });
});

describe('SpyStore v5 — loop_ticks', () => {
  test('insertLoopTick creates tick', async () => {
    await setupStore();
    const tickId = randomUUID();
    const ok = store.insertLoopTick({ tickId, topicId: 'fin', quotaDay: '2026-08-20' });
    expect(ok).toBe(true);
    const row = store.getLastTick('fin');
    expect(String(row!['tick_id'])).toBe(tickId);
    expect(String(row!['status'])).toBe('running');
  });

  test('insertLoopTick UNIQUE(topic_id,quota_day) returns false on duplicate', async () => {
    await setupStore();
    const ok1 = store.insertLoopTick({ tickId: randomUUID(), topicId: 'fin', quotaDay: '2026-08-20' });
    const ok2 = store.insertLoopTick({ tickId: randomUUID(), topicId: 'fin', quotaDay: '2026-08-20' });
    expect(ok1).toBe(true);
    expect(ok2).toBe(false);
  });

  test('updateLoopTick marks done and records finished_at', async () => {
    await setupStore();
    const tickId = randomUUID();
    store.insertLoopTick({ tickId, topicId: 'fin', quotaDay: '2026-08-20' });
    store.updateLoopTick(tickId, {
      status: 'done',
      searchCallsUsed: 10,
      generalUnitsUsed: 50,
      newCandidates: 5,
      newShortlistedAuto: 2,
    });
    const row = store.getLastTick('fin');
    expect(String(row!['status'])).toBe('done');
    expect(Number(row!['search_calls_used'])).toBe(10);
    expect(row!['finished_at']).not.toBeNull();
  });
});

describe('SpyStore v5 — daily_reports', () => {
  test('insertDailyReport and getDailyReportByDate', async () => {
    await setupStore();
    const reportId = randomUUID();
    store.insertDailyReport({
      reportId,
      reportDate: '2026-08-20',
      topicId: 'finance-vi',
      summaryJson: '{"version":1}',
      markdown: '# Report\nTest',
    });
    const row = store.getDailyReportByDate('finance-vi', '2026-08-20');
    expect(row).not.toBeNull();
    expect(String(row!['report_id'])).toBe(reportId);
    expect(String(row!['markdown'])).toContain('# Report');
  });

  test('markDelivered adds key to delivered_json', async () => {
    await setupStore();
    const reportId = randomUUID();
    store.insertDailyReport({
      reportId,
      reportDate: '2026-08-20',
      topicId: 'finance-vi',
      summaryJson: '{}',
      markdown: '',
    });
    store.markDelivered(reportId, 'mcp_read', '2026-08-20T10:00:00Z');
    const row = store.getDailyReport(reportId);
    const delivered = JSON.parse(String(row!['delivered_json'])) as Record<string, string>;
    expect(delivered['mcp_read']).toBe('2026-08-20T10:00:00Z');
  });
});

describe('SpyStore v5 — nguồn ngoài đã bị gỡ khỏi schema', () => {
  test('bảng term_external_estimates KHÔNG còn tồn tại', async () => {
    await setupStore();
    // Dự án tồn tại để THAY THẾ provider ngoài (ADR-AL-6) — không có chỗ chứa
    // ước lượng mua từ vendor nào cả.
    const db = new Database(store.databasePath, { readonly: true });
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='term_external_estimates'")
      .get();
    db.close();
    expect(row).toBeNull();
  });
});

describe('SpyStore v5 — faceless hint vs verdict', () => {
  test('faceless_hint ghi riêng, faceless_score để NULL', async () => {
    await setupStore();
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi' });
    store.upsertTopicChannel({
      topicId: 'fin',
      channelId: 'UChint',
      fitScore: 60,
      facelessScore: null,
      facelessHint: 0.82,
      facelessHintReasonsJson: '{"method":"text_only","reasons":[]}',
      status: 'new',
    });
    const rows = store.listTopicChannels('fin');
    expect(rows[0]!['faceless_score']).toBeNull();
    expect(Number(rows[0]!['faceless_hint'])).toBeCloseTo(0.82, 5);
    expect(String(rows[0]!['faceless_hint_reasons_json'])).toContain('text_only');
  });

  test('upsert lần hai không xoá hint đã có (COALESCE)', async () => {
    await setupStore();
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi' });
    store.upsertTopicChannel({ topicId: 'fin', channelId: 'UChint', facelessHint: 0.7, status: 'new' });
    store.upsertTopicChannel({ topicId: 'fin', channelId: 'UChint', fitScore: 55, status: 'new' });
    const rows = store.listTopicChannels('fin');
    expect(Number(rows[0]!['faceless_hint'])).toBeCloseTo(0.7, 5);
    expect(Number(rows[0]!['fit_score'])).toBe(55);
  });
});

describe('SpyStore v5 — decided_reason', () => {
  test('decideTopicChannels ghi lý do máy đọc được', async () => {
    await setupStore();
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi' });
    store.upsertTopicChannel({ topicId: 'fin', channelId: 'UC1', status: 'new' });
    store.decideTopicChannels('fin', ['UC1'], 'rejected', 'loop_auto', 'lang_mismatch');
    const rows = store.listTopicChannels('fin', { status: 'rejected' });
    expect(String(rows[0]!['decided_reason'])).toBe('lang_mismatch');
  });

  test('quyết định của người dùng không cần lý do', async () => {
    await setupStore();
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi' });
    store.upsertTopicChannel({ topicId: 'fin', channelId: 'UC1', status: 'new' });
    store.decideTopicChannels('fin', ['UC1'], 'active', 'user');
    const rows = store.listTopicChannels('fin', { status: 'active' });
    expect(rows[0]!['decided_reason']).toBeNull();
    expect(String(rows[0]!['decided_by'])).toBe('user');
  });
});

describe('SpyStore v5 — importCorpusChannelsToTopic (0 quota)', () => {
  test('copy kênh trong corpus sang topic dưới dạng candidate corpus_import + status new', async () => {
    await setupStore();
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi' });
    store.upsertChannel({
      channelId: 'UCcorpus1',
      title: 'Kênh đã spy 1',
      subscriberCount: 120_000,
      videoCount: 80,
      totalViewCount: 9_000_000,
      fetchedAt: '2026-08-01T00:00:00Z',
    });
    store.upsertChannel({
      channelId: 'UCcorpus2',
      title: 'Kênh đã spy 2',
      subscriberCount: 40_000,
      videoCount: 30,
      totalViewCount: 1_000_000,
      fetchedAt: '2026-08-02T00:00:00Z',
    });

    const result = store.importCorpusChannelsToTopic('fin', 'vi');
    expect(result.imported.sort()).toEqual(['UCcorpus1', 'UCcorpus2']);
    expect(result.skipped).toHaveLength(0);

    const candidates = store.listCandidates({ discoveredVia: 'corpus_import' });
    expect(candidates).toHaveLength(2);
    expect(store.countTopicChannelsByStatus('fin')['new']).toBe(2);
  });

  test('chạy lần hai không đè kênh đã quyết định', async () => {
    await setupStore();
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi' });
    store.upsertChannel({
      channelId: 'UCcorpus1',
      title: 'Kênh đã spy 1',
      subscriberCount: 1000,
      videoCount: 10,
      totalViewCount: 5000,
      fetchedAt: '2026-08-01T00:00:00Z',
    });
    store.importCorpusChannelsToTopic('fin', 'vi');
    store.decideTopicChannels('fin', ['UCcorpus1'], 'rejected', 'user');

    const second = store.importCorpusChannelsToTopic('fin', 'vi');
    expect(second.imported).toHaveLength(0);
    expect(second.skipped).toEqual(['UCcorpus1']);
    expect(String(store.listTopicChannels('fin', { status: 'rejected' })[0]!['channel_id'])).toBe('UCcorpus1');
  });
});

describe('SpyStore v5 — quyết định là dính', () => {
  test('upsertTopicChannel không kéo kênh đã quyết định về new', async () => {
    await setupStore();
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi' });
    store.upsertTopicChannel({ topicId: 'fin', channelId: 'UC1', status: 'new' });
    store.decideTopicChannels('fin', ['UC1'], 'rejected', 'user');

    // Tick sau chấm lại điểm — status phải giữ nguyên 'rejected'.
    store.upsertTopicChannel({ topicId: 'fin', channelId: 'UC1', fitScore: 90, status: 'new' });

    const rows = store.listTopicChannels('fin', {});
    expect(String(rows[0]!['status'])).toBe('rejected');
    expect(String(rows[0]!['decided_by'])).toBe('user');
    expect(Number(rows[0]!['fit_score'])).toBe(90);
  });
});

describe('SpyStore v5 — provenance đọc được (foundVia)', () => {
  test('getTopicChannelSource trả đường ĐẦU TIÊN, kèm term_key', async () => {
    await setupStore();
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi' });
    store.addTopicChannelSource({
      topicId: 'fin', channelId: 'UC1', relation: 'search_video', termKey: 'lai_kep',
    });
    store.addTopicChannelSource({
      topicId: 'fin', channelId: 'UC1', relation: 'graph', fromChannelId: 'UCseed',
    });

    const first = store.getTopicChannelSource('fin', 'UC1');
    expect(first).not.toBeNull();
    expect(String(first!['relation'])).toBe('search_video');
    expect(String(first!['term_key'])).toBe('lai_kep');

    expect(store.listTopicChannelSources('fin')).toHaveLength(2);
    expect(store.listTopicChannelSources('fin', 'UC1')).toHaveLength(2);
  });

  test('kênh chưa có provenance trả null, không ném', async () => {
    await setupStore();
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi' });
    expect(store.getTopicChannelSource('fin', 'UCunknown')).toBeNull();
  });
});

describe('SpyStore v5 — thumbnails + learn_value reasons', () => {
  test('lưu và đọc lại thumbnails_json, learn_value_reasons_json', async () => {
    await setupStore();
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi' });
    store.upsertTopicChannel({
      topicId: 'fin',
      channelId: 'UC1',
      thumbnailsJson: JSON.stringify(['https://i.ytimg.com/vi/a/hqdefault.jpg']),
      learnValueScore: 62,
      learnValueReasonsJson: JSON.stringify({
        method: 'deterministic',
        sampleSize: 12,
        reasons: [{ factor: 'cadence', points: 15, max: 15, detail: '12 video', method: 'deterministic', sampleSize: 12 }],
      }),
      status: 'new',
    });
    const row = store.listTopicChannels('fin')[0]!;
    expect(JSON.parse(String(row['thumbnails_json']))).toHaveLength(1);
    const lv = JSON.parse(String(row['learn_value_reasons_json'])) as { method: string; sampleSize: number };
    expect(lv.method).toBe('deterministic');
    expect(lv.sampleSize).toBe(12);
  });
});

describe('provenance — corpus import mang nhãn corpus_import', () => {
  test('provenance corpus_import được ghi vào ROW THẬT, không phải manual', async () => {
    await setupStore();
    store.upsertTopic({ topicId: 'fin', label: 'Finance', market: 'vi', language: 'vi' });
    store.upsertChannel({
      channelId: 'UCcorpusprov000000001',
      title: 'Kênh đã spy',
      subscriberCount: 1000,
      videoCount: 10,
      totalViewCount: 5000,
      fetchedAt: '2026-08-01T00:00:00Z',
    });

    store.importCorpusChannelsToTopic('fin', 'vi');

    const raw = new Database(store.databasePath, { readonly: true });
    const row = raw.prepare(
      'SELECT discovered_via FROM candidate_channels WHERE channel_id=?',
    ).get('UCcorpusprov000000001') as { discovered_via: string } | null;
    const source = raw.prepare(
      'SELECT relation FROM topic_channel_sources WHERE topic_id=? AND channel_id=?',
    ).get('fin', 'UCcorpusprov000000001') as { relation: string } | null;
    raw.close();

    expect(row?.discovered_via).toBe('corpus_import');
    expect(source?.relation).toBe('corpus_import');
    // Corpus import là đường TỰ ĐỘNG — không được mượn nhãn attestation của người.
    expect(row?.discovered_via).not.toBe('manual_user');
  });

  test('provenance — nhãn manual cũ được migrate thành manual_user, không đoán tốt', async () => {
    await setupStore();
    const path = store.databasePath;
    // Giả lập DB cũ: hàng mang nhãn 'manual' chung chung, và kênh đó CÓ trong
    // corpus — đúng cái cám dỗ đoán 'corpus_import'.
    const write = new Database(path);
    write.exec(
      `INSERT INTO candidate_channels (channel_id, discovered_via, status, first_seen_at, refreshed_at)
       VALUES ('UClegacy00000000000001', 'manual', 'new', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`,
    );
    write.exec(
      `INSERT INTO topic_channel_sources (topic_id, channel_id, relation, seen_at)
       VALUES ('fin', 'UClegacy00000000000001', 'manual', '2026-08-01T00:00:00Z')`,
    );
    write.close();
    store.close();

    // Mở lại = chạy migration.
    store = new SpyStore(path);

    const raw = new Database(path, { readonly: true });
    const row = raw.prepare(
      'SELECT discovered_via FROM candidate_channels WHERE channel_id=?',
    ).get('UClegacy00000000000001') as { discovered_via: string };
    const source = raw.prepare(
      'SELECT relation FROM topic_channel_sources WHERE channel_id=?',
    ).get('UClegacy00000000000001') as { relation: string };
    const anyManual = raw.prepare(
      "SELECT count(*) AS n FROM candidate_channels WHERE discovered_via='manual'",
    ).get() as { n: number };
    raw.close();

    // Không CHỨNG MINH được nguồn gốc hàng cũ → nhãn "cần soi", không phải nhãn
    // "tự lực, kiểm chứng được".
    expect(row.discovered_via).toBe('manual_user');
    expect(source.relation).toBe('manual_user');
    expect(anyManual.n).toBe(0);
  });
});
