#!/usr/bin/env bun
/**
 * scripts/spy-migrate-tsv-v3.ts — Di trú MỘT LẦN dữ liệu sheet v2 → DB v13
 * cho topic `pov-finance` theo §4.6 của plan spy-research-pipeline-v3-lean.
 *
 * Nguồn (mặc định writer-room-data/spy-sheet):
 *   loop/follow_list.tsv      → topic_channels status=active (đi qua decideChannel
 *                               actor='human' — migration là hành động của người)
 *   loop/inbox_channels.tsv   → topic_channels status=new|rejected; thiếu
 *                               channel_id → bỏ qua + liệt kê trong báo cáo
 *   loop/snapshots.tsv        → topic_videos (latest_* từ snapshot mới nhất)
 *                               + video_daily_views (1 dòng / video / ngày)
 *   state/keyword_index.tsv   → topic_keywords; thiếu origin → rejected(no_origin)
 *
 * Đối chiếu ngược: đếm dòng in/out + tổng cột view giữa TSV và DB — số đọc THÔ
 * từ TSV (Number() trên chuỗi nguyên), không qua locale.
 *
 * Cách chạy:
 *   bun scripts/spy-migrate-tsv-v3.ts --db /tmp/spy-v13-copy.sqlite
 *   bun scripts/spy-migrate-tsv-v3.ts --db /tmp/spy-v13-copy.sqlite --dry-run
 *
 * --dry-run chạy toàn bộ trong transaction rồi ROLLBACK: báo cáo đầy đủ như thật
 * nhưng không ghi gì vào DB.
 */
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SpyStore } from '../packages/spy/src/store.ts';
import { normalizeTermKey } from '../packages/spy/src/topic.ts';

const TOPIC_ID = 'pov-finance';
const TOPIC = {
  label: 'POV Finance',
  market: 'us',
  language: 'en',
  region: 'US',
};

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
let dbPath: string | null = null;
let dataDir = join(import.meta.dir, '..', 'writer-room-data', 'spy-sheet');
let dryRun = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--db') dbPath = args[++i] ?? null;
  else if (args[i] === '--data-dir') dataDir = args[++i] ?? dataDir;
  else if (args[i] === '--dry-run') dryRun = true;
  else {
    console.error(`Tham số không nhận diện được: ${args[i]}`);
    process.exit(2);
  }
}
if (!dbPath) {
  console.error('Thiếu --db <path>. KHÔNG trỏ vào writer-room-data/spy/spy.sqlite thật — dùng bản copy.');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// TSV helpers — số đọc thô: Number() trực tiếp trên chuỗi, không format locale.
// ---------------------------------------------------------------------------
function readTsv(path: string): Record<string, string>[] {
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== '');
  const header = lines[0]!.split('\t');
  return lines.slice(1).map((line) => {
    const cells = line.split('\t');
    const row: Record<string, string> = {};
    header.forEach((key, idx) => { row[key] = cells[idx] ?? ''; });
    return row;
  });
}

/** Số thô — NaN → null (cột số rỗng vẫn phải đếm được). */
function rawInt(cell: string | undefined): number | null {
  const n = Number((cell ?? '').trim());
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
function rawNum(cell: string | undefined): number | null {
  const n = Number((cell ?? '').trim());
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Đọc nguồn
// ---------------------------------------------------------------------------
const followList = readTsv(join(dataDir, 'loop', 'follow_list.tsv'));
const inboxChannels = readTsv(join(dataDir, 'loop', 'inbox_channels.tsv'));
const snapshots = readTsv(join(dataDir, 'loop', 'snapshots.tsv'));
const keywordIndex = readTsv(join(dataDir, 'state', 'keyword_index.tsv'));

// Tổng cột view phía TSV (đối chiếu ngược) — cộng số thô trước khi ghi.
const tsvViewSum = snapshots.reduce((sum, row) => sum + (rawInt(row['view_count']) ?? 0), 0);
const tsvInboxMaxViewsSum = inboxChannels.reduce((sum, row) => sum + (rawInt(row['max_views']) ?? 0), 0);

// ---------------------------------------------------------------------------
// Mở DB — store tự migrate → v13 khi mở bản copy v12.
// `database` là private trong SpyStore; script cần transaction + vài INSERT
// trực tiếp nên truy cập qua cast — vẫn đi qua store contract cho mọi hành vi
// có quy tắc HITL (decide*, recordVideoDailyView, upsertTopicVideo).
// ---------------------------------------------------------------------------
const store = new SpyStore(dbPath);
const db = (store as unknown as { database: Database }).database;

const report: string[] = [];
const skippedInbox: string[] = [];
const skippedFollow: string[] = [];
const counters = {
  followIn: followList.length, followImported: 0, followAlready: 0, followSkipped: 0,
  inboxIn: inboxChannels.length, inboxImported: 0, inboxSkipped: 0,
  snapIn: snapshots.length, snapViewsInserted: 0, snapVideosUpserted: 0,
  kwIn: keywordIndex.length, kwImported: 0, kwDedupOrExisting: 0,
  kwActive: 0, kwPending: 0, kwRejected: 0,
};

const now = new Date().toISOString();

db.exec('BEGIN');
try {
  // -- Topic ---------------------------------------------------------------
  store.upsertTopic({ topicId: TOPIC_ID, ...TOPIC });

  // -- follow_list → topic_channels status=active --------------------------
  // §4.6 map phẳng → active. Insert 'new' rồi decideChannel(actor=human) để
  // mọi đổi trạng thái đều có dòng decisions (tôn chỉ 1).
  const insertFollowChannel = db.prepare(
    `INSERT OR IGNORE INTO topic_channels
       (topic_id, channel_id, title, handle, status, discovered_via, discovered_from,
        last_checked_at, first_seen_at)
     VALUES (?, ?, ?, ?, 'new', 'user', 'follow_list.tsv', ?, ?)`,
  );
  const insertInboxChannel = db.prepare(
    `INSERT OR IGNORE INTO topic_channels
       (topic_id, channel_id, title, handle, status, discovered_via, discovered_from,
        first_seen_at)
     VALUES (?, ?, ?, ?, 'new', 'keyword_search', ?, ?)`,
  );
  for (const row of followList) {
    const channelId = row['channel_id']!.trim();
    if (!channelId) {
      counters.followSkipped += 1;
      skippedFollow.push(`${row['channel_title'] || '(no title)'} | handle=${row['handle'] || '-'} | status=${row['status'] || '-'}`);
      continue;
    }
    const firstSeen = row['added_at'] || now;
    const result = insertFollowChannel.run(
      TOPIC_ID, channelId, row['channel_title'] || null, row['handle'] || null,
      row['last_scanned'] || null, firstSeen,
    );
    if (Number(result.changes) === 0) {
      counters.followAlready += 1;
      continue;
    }
    // Status gốc TSV ('active'|'watch') giữ trong reason để truy vết — plan
    // quyết cả hai đều vào Follow List.
    store.decideChannel(TOPIC_ID, channelId, 'active', `tsv_follow_list:${row['status'] || 'active'}`);
    counters.followImported += 1;
  }

  // -- inbox_channels → topic_channels status=new|rejected ------------------
  // TSV hiện tại KHÔNG có cột channel_id → theo §4.6 toàn bộ bị bỏ qua và
  // liệt kê trong báo cáo. Giữ logic chung cho trường hợp TSV có cột này.
  for (const row of inboxChannels) {
    const channelId = (row['channel_id'] ?? '').trim();
    if (!channelId) {
      counters.inboxSkipped += 1;
      skippedInbox.push(
        `${row['channel_title'] || '(no title)'} | kw=${row['keyword_trigger'] || '-'} | found_at=${row['found_at'] || '-'}`,
      );
      continue;
    }
    insertInboxChannel.run(
      TOPIC_ID, channelId, row['channel_title'] || null, null,
      row['keyword_trigger'] || null, row['found_at'] || now,
    );
    // decision=rejected → rejected (quyết định người đã có từ sheet v2).
    if ((row['decision'] ?? '').trim() === 'rejected') {
      store.decideChannel(TOPIC_ID, channelId, 'rejected', `tsv_inbox:${row['reason'] || 'rejected'}`);
    }
    counters.inboxImported += 1;
  }

  // -- snapshots → topic_videos + video_daily_views -------------------------
  // Mỗi dòng = 1 snapshot ngày → video_daily_views(day=snapshot_date).
  // upsert theo thứ tự ngày: dòng đầu đặt first_seen_at, dòng cuối làm latest_*.
  const byVideo = new Map<string, Record<string, string>[]>();
  for (const row of snapshots) {
    const videoId = row['video_id']!.trim();
    if (!videoId) continue;
    const list = byVideo.get(videoId) ?? [];
    list.push(row);
    byVideo.set(videoId, list);
  }
  for (const [videoId, rows] of byVideo) {
    rows.sort((a, b) => (a['snapshot_date'] ?? '').localeCompare(b['snapshot_date'] ?? ''));
    for (const row of rows) {
      const views = rawInt(row['view_count']);
      if (views === null) continue;
      const { inserted } = store.recordVideoDailyView({
        topicId: TOPIC_ID,
        videoId,
        day: row['snapshot_date']!,
        views,
        capturedAt: `${row['snapshot_date']}T00:00:00.000Z`,
      });
      if (inserted) counters.snapViewsInserted += 1;
      store.upsertTopicVideo({
        topicId: TOPIC_ID,
        videoId,
        channelId: row['channel_id'] || '',
        title: row['title'] || '',
        publishedAt: row['published_at'] || null,
        durationSec: rawNum(row['duration_sec']),
        // Corpus ban đầu của topic — không phải daily_scan/weekly_search.
        source: 'setup',
        views,
        capturedAt: `${row['snapshot_date']}T00:00:00.000Z`,
      });
    }
    counters.snapVideosUpserted += 1;
  }

  // -- keyword_index → topic_keywords ---------------------------------------
  // trang_thai: active→active, cho_kiem→pending, quarantine→rejected.
  // origin enum v13: seed|title_ngram|outlier_title|user — map:
  //   title_ngram_kenh_follow→title_ngram; search_validated→seed (tập gốc đã
  //   được kiểm qua search); thiếu → NULL + rejected(no_origin) theo §4.6.
  const originMap: Record<string, string> = {
    title_ngram_kenh_follow: 'title_ngram',
    search_validated: 'seed',
  };
  const insertKeyword = db.prepare(
    `INSERT OR IGNORE INTO topic_keywords
       (topic_id, term_key, display_term, relation, evidence_json, status, origin,
        last_checked_at, last_median_views, added_at, added_by)
     VALUES (?, ?, ?, '', ?, 'pending', ?, ?, ?, ?, 'user')`,
  );
  for (const row of keywordIndex) {
    const displayTerm = row['keyword']!.trim();
    if (!displayTerm) continue;
    const termKey = normalizeTermKey(displayTerm);
    const tsvOrigin = (row['origin'] ?? '').trim();
    const origin = originMap[tsvOrigin] ?? null;
    const tsvStatus = (row['trang_thai'] ?? '').trim();
    const evidence = JSON.stringify({
      source: 'keyword_index.tsv',
      pct_in_niche: rawNum(row['pct_ket_qua_dung_nganh']),
      median_view_top20: rawNum(row['median_view_top20']),
      trend: row['xu_huong'] || null,
      tsv_status: tsvStatus || null,
      tsv_origin: tsvOrigin || null,
    });
    const result = insertKeyword.run(
      TOPIC_ID, termKey, displayTerm, evidence, origin,
      row['last_scored'] || null, rawNum(row['median_view_top20']),
      row['last_scored'] || now,
    );
    if (Number(result.changes) === 0) {
      counters.kwDedupOrExisting += 1;
      continue;
    }
    counters.kwImported += 1;
    // Mọi đích khác pending đều đi qua quyết định người (audit đầy đủ).
    if (!origin) {
      store.decideKeyword(TOPIC_ID, termKey, 'rejected', 'no_origin');
      counters.kwRejected += 1;
    } else if (tsvStatus === 'active') {
      store.decideKeyword(TOPIC_ID, termKey, 'active', 'tsv_keyword_index:active');
      counters.kwActive += 1;
    } else if (tsvStatus === 'quarantine') {
      store.decideKeyword(TOPIC_ID, termKey, 'rejected', 'tsv_keyword_index:quarantine');
      counters.kwRejected += 1;
    } else {
      counters.kwPending += 1;
    }
  }

  // -- Đối chiếu ngược (chạy TRONG transaction trước khi commit/rollback) ---
  const dbChannels = store.listTopicChannelsByStatus(TOPIC_ID, ['new', 'active', 'paused', 'rejected', 'own']);
  const dbKeywords = store.listKeywordsByStatus(TOPIC_ID, ['pending', 'active', 'paused', 'rejected']);
  const dbVideos = store.listTopicVideos(TOPIC_ID, { limit: 100000 });
  const dbViewSum = db.prepare(
    'SELECT COALESCE(SUM(views),0) AS s, COUNT(*) AS n FROM video_daily_views WHERE topic_id=?',
  ).get(TOPIC_ID) as { s: number; n: number };
  const decisionCount = (db.prepare(
    'SELECT COUNT(*) AS n FROM decisions WHERE topic_id=?',
  ).get(TOPIC_ID) as { n: number }).n;

  report.push('=== ĐỐI CHIẾU NGƯỢC TSV → DB v13 (topic pov-finance) ===');
  report.push(`[topic] upserted pov-finance market=${TOPIC.market} language=${TOPIC.language} region=${TOPIC.region}`);
  report.push(`[follow_list] in=${counters.followIn} → imported=${counters.followImported} already=${counters.followAlready} skipped_no_channel_id=${counters.followSkipped} | DB channels(active)=${dbChannels.filter((c) => c.status === 'active').length}`);
  report.push(`[inbox_channels] in=${counters.inboxIn} → imported=${counters.inboxImported} skipped_no_channel_id=${counters.inboxSkipped} (max_views sum skipped=${tsvInboxMaxViewsSum})`);
  report.push(`[snapshots] in=${counters.snapIn} → daily_views inserted=${counters.snapViewsInserted} videos upserted=${counters.snapVideosUpserted} | DB videos=${dbVideos.length} daily_views=${dbViewSum.n}`);
  report.push(`[snapshots] view_sum: TSV=${tsvViewSum} DB=${dbViewSum.s} → ${tsvViewSum === dbViewSum.s ? 'MATCH' : 'MISMATCH'}`);
  report.push(`[keyword_index] in=${counters.kwIn} → imported=${counters.kwImported} dedup_or_existing=${counters.kwDedupOrExisting} | DB keywords=${dbKeywords.length} (active=${counters.kwActive} pending=${counters.kwPending} rejected=${counters.kwRejected})`);
  report.push(`[decisions] rows=${decisionCount} (kênh active + keyword active/rejected đều có audit actor=human)`);
  if (skippedFollow.length > 0) {
    report.push(`--- follow_list bị bỏ qua — thiếu channel_id (${skippedFollow.length}) ---`);
    report.push(...skippedFollow);
  }
  if (skippedInbox.length > 0) {
    report.push(`--- inbox bị bỏ qua — thiếu channel_id (${skippedInbox.length}) ---`);
    report.push(...skippedInbox);
  }

  if (dryRun) {
    db.exec('ROLLBACK');
    report.push('--- DRY-RUN: đã ROLLBACK, DB không đổi ---');
  } else {
    db.exec('COMMIT');
  }
} catch (error) {
  db.exec('ROLLBACK');
  console.error('Migration thất bại, đã rollback:', error);
  process.exit(1);
} finally {
  store.close();
}

console.log(report.join('\n'));
